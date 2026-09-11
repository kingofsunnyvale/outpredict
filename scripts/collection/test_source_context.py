import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from source_context import SourceContextStore,academic_context_gate,metric_labels,audit_cached

class SourceContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);(self.root/'artifacts').mkdir()
        with sqlite3.connect(self.root/'manifest.sqlite') as db:
            db.executescript('CREATE TABLE artifact(hash TEXT,bytes INTEGER,path TEXT); CREATE TABLE post(account_key TEXT,post_id TEXT,hash TEXT,source_url TEXT);')
    def tearDown(self):self.tmp.cleanup()
    def fixture(self,reply,question='What is your sGPA including your post-bacc science courses ?',quoted=True,uid='123',other_question=None):
        quote=(f'<blockquote data-quote="Faha" data-attributes="member: 456" data-source="post: 1"><div class="bbCodeBlock-title">Faha said:</div><div class="bbCodeBlock-content"><div class="bbCodeBlock-expandContent">{question}</div><div>Click to expand...</div></div></blockquote>') if quoted else ''
        html=(f'<article class="message--post" data-content="post-1" data-author="Faha"><a class="username" data-user-id="456">Faha</a><div class="bbWrapper">{other_question or question}</div></article>'
              f'<article class="message--post" data-content="post-2" data-author="Applicant"><a class="username" data-user-id="{uid}">Applicant</a><div class="bbWrapper">{quote}{reply}</div></article>')
        raw=html.encode();h=hashlib.sha256(raw).hexdigest();path=self.root/'artifacts'/(h+'.html');path.write_bytes(raw)
        url='https://forums.studentdoctor.net/threads/test.123/#post-2'
        with sqlite3.connect(self.root/'manifest.sqlite') as db:
            db.execute('INSERT INTO artifact VALUES(?,?,?)',(h,len(raw),str(path.relative_to(self.root))));db.execute('INSERT INTO post VALUES(?,?,?,?)',('sdn:123','post-2',h,url))
        # Test expected text is independent of production Tree.
        from html import unescape
        post={'postId':'post-2','sourceArtifactSha256':h,'sourceUrl':url,'text':unescape(reply)}
        return {'accountKey':'sdn:123','contentDigest':'fixture','posts':[post]},path
    def gate(self,pack,metric='gpa',value='2.84',quote=None):
        facts={'academics':[[metric,value,'1',quote or pack['posts'][0]['text']]]}
        with SourceContextStore(self.root) as store:return academic_context_gate(facts,pack,{'academics:0'},store)
    def test_original_science_question_blocks_cumulative_reply_and_verifies_attribution(self):
        pack,_=self.fixture('Still only a 2.84 with post bacc courses included.')
        r=self.gate(pack);self.assertEqual(r['blockedFields'],['academics:0']);f=r['findings'][0]
        self.assertEqual(f['code'],'academic_context_metric_mismatch');self.assertEqual(f['inferredQuestionMetrics'],['scienceGpa'])
        q=f['quotedContexts'][0];self.assertEqual(q['author'],'Faha');self.assertEqual(q['sourcePostId'],'post-1');self.assertTrue(q['attributionVerifiedInCapture'])
        self.assertNotIn('Faha',pack['posts'][0]['text']);self.assertNotIn('Click to expand',q['text'])
    def test_matching_context_is_still_blocked_until_its_provenance_is_retained(self):
        pack,_=self.fixture('Still only a 2.84 with post bacc courses included.')
        r=self.gate(pack,'scienceGpa');self.assertEqual(r['blockedFields'],['academics:0']);self.assertEqual(r['findings'][0]['code'],'academic_identity_depends_on_excluded_context')
    def test_multiple_metrics_in_question_are_ambiguous(self):
        pack,_=self.fixture('2.84.','What are your cGPA and sGPA?');r=self.gate(pack)
        self.assertEqual(r['findings'][0]['code'],'academic_context_ambiguous_identity')
    def test_own_explicit_type_survives_unrelated_and_conflicting_questions(self):
        pack,_=self.fixture('My cGPA is 3.87.','What was your MCAT?')
        self.assertEqual(self.gate(pack,value='3.87',quote='3.87')['blockedFields'],[])
        pack,_=self.fixture('My science GPA is 2.84.','What was your cumulative GPA?')
        self.assertEqual(self.gate(pack,'scienceGpa')['blockedFields'],[])
    def test_explicit_metric_in_preceding_sentence_retains_own_context(self):
        pack,_=self.fixture('I wrote the wrong MCAT score. My score is 517.','Your MCAT is 520 or 517?')
        self.assertEqual(self.gate(pack,'mcat','517','My score is 517.')['blockedFields'],[])
        pack,_=self.fixture('For my second MCAT, I worked hard. I scored a 520 (131, 130, 129, 130).','What was your MCAT history?')
        self.assertEqual(self.gate(pack,'mcat','520','I scored a 520 (131, 130, 129, 130).')['blockedFields'],[])
    def test_other_authors_question_is_not_silently_attached_without_a_quote(self):
        pack,_=self.fixture('Still only a 2.84.',quoted=False)
        self.assertEqual(self.gate(pack)['blockedFields'],[])
    def test_generic_gpa_cannot_override_specific_science_question(self):
        pack,_=self.fixture('My GPA is 2.84.')
        self.assertEqual(self.gate(pack)['blockedFields'],['academics:0'])
        pack,_=self.fixture('My GPA is 2.84.','What is your GPA?')
        self.assertEqual(self.gate(pack)['blockedFields'],[])
    def test_corruption_and_wrong_author_fail_closed(self):
        pack,path=self.fixture('Still 2.84.');path.write_bytes(path.read_bytes()+b'corrupt')
        r=self.gate(pack);self.assertEqual(r['findings'][0]['detail'],'capture_digest_mismatch')
        pack,_=self.fixture('Only 2.84.',uid='999')
        r=self.gate(pack);self.assertEqual(r['findings'][0]['detail'],'source_author_mismatch')
    def test_unicode_and_entities_preserve_separate_context_without_changing_author_text(self):
        pack,_=self.fixture('I’m at 2.84 🙂 &amp; improving.','What is your sGPA &amp; why?')
        r=self.gate(pack);f=r['findings'][0]
        self.assertEqual(f['authorReply'],'I’m at 2.84 🙂 & improving.');self.assertEqual(f['quotedContexts'][0]['text'],'What is your sGPA & why?')
        self.assertTrue(f['quotedContexts'][0]['attributionVerifiedInCapture'])
    def test_cache_audit_reads_supported_only_and_does_not_modify_inputs(self):
        pack,_=self.fixture('Still 2.84.');packs=self.root/'packs';packs.mkdir();p=packs/'pack.json';p.write_text(json.dumps(pack));e=packs/'extract.json';e.write_text(json.dumps({'contentDigest':'fixture','facts':{'academics':[['gpa','2.84','1','Still 2.84.'],['scienceGpa','2.84','1','Still 2.84.']]}}))
        reviews=self.root/'field-reviews';reviews.mkdir();r=reviews/'review.json';r.write_text(json.dumps({'reviewStatus':'field_reviewed_candidate','accountKey':'sdn:123','packPath':str(p),'extractionPath':str(e),'contentDigest':'fixture','supportedFields':['academics:0']}))
        before={x:x.read_bytes() for x in [p,e,r,self.root/'manifest.sqlite']};audit=audit_cached(self.root)
        self.assertEqual(audit['affectedUniqueFields'],1);self.assertEqual(audit['approvedNumericFields'],1);self.assertEqual(audit['errors'],[])
        self.assertEqual(before,{x:x.read_bytes() for x in before})
    def test_metric_token_boundaries(self):
        self.assertEqual([m['metric'] for m in metric_labels('cGPA 3.4, sGPA 3.3, BCPM 3.2, MCAT 512, GPA 3.5')],['gpa','scienceGpa','scienceGpa','mcat','gpa_unspecified'])
        self.assertEqual(metric_labels('GPAR MCATish scGPAX'),[])

if __name__=='__main__':unittest.main()
