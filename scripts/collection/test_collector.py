import tempfile,time,unittest
from pathlib import Path
from collector import Store,Fetcher,retry_after
from parsers import parse_html,classify_url

THREAD='https://forums.studentdoctor.net/threads/test.1234567/'
HTML='''<html><head><title>Applicant update</title><link rel="next" href="/threads/test.1234567/page-2"></head><body>
<article class="message message--post" data-author="one" data-content="post-1"><a class="username" data-user-id="42">one</a><time datetime="2025-01-01"></time><article class="message-body"><div class="bbWrapper">My MCAT 515 and cGPA 3.80. <blockquote>Other applicant: I was accepted.</blockquote>Research 300 hours.<img src="/attachments/a.png"></div></article></article>
<article class="message message--post" data-author="advisor" data-content="post-2"><a class="username" data-user-id="43">advisor</a><div class="bbWrapper">You should be accepted.</div></article></body></html>'''
MD='''<section class="profile-page"><div id="profileheader"><h2>example</h2></div><div id="subcontent"><div id="appcycle_1_box"><h3>Application Cycle One: 06/01/2025</h3><ul><li><span>Overall GPA:</span> 3.8<li><span>Total MCAT SCORE:</span> 515<li></ul><p>Research and clinical activities.</p><div class="results-box" id="application_1_box"><span class="results-trigger">School A</span><ul><li><span>Accepted:</span> No</li><li><span>Rejected:</span> No</li></ul></div><div class="results-box" id="application_2_box"><span class="results-trigger">School B</span><ul><li><span>Accepted:</span> No</li><li><span>Rejected:</span> Yes</li></ul></div></div></div></section>'''
class Tests(unittest.TestCase):
    def test_url_boundaries(self):
        self.assertEqual(classify_url(THREAD)['key'],'sdn:thread:1234567:1')
        for url in ['http://forums.studentdoctor.net/threads/1234567/','https://forums.studentdoctor.net/login','https://attacker.test/threads/1234567/','https://user:pass@forums.studentdoctor.net/threads/1234567/']:
            with self.assertRaises(ValueError):classify_url(url)
    def test_author_quote_and_pagination(self):
        r=parse_html(HTML,THREAD,'sdn:42','one')
        self.assertEqual(len(r['posts']),1)
        self.assertNotIn('accepted',r['posts'][0]['text'])
        self.assertEqual(r['posts'][0]['excludedQuotedBlocks'],1)
        self.assertEqual(r['next'],[THREAD+'page-2'])
        self.assertEqual(r['candidates']['outcome']['mentionCount'],0)
    def test_wrong_identity_does_not_capture_advisor(self):
        with self.assertRaises(ValueError):parse_html(HTML,THREAD,'sdn:900','one')
    def test_later_page_needs_identity_and_follows_zero_op_posts(self):
        html=HTML.replace('page-2','page-3')
        with self.assertRaises(ValueError):parse_html(html,THREAD+'page-2')
        r=parse_html(html,THREAD+'page-2','sdn:900','original')
        self.assertEqual(r['posts'],[])
        self.assertEqual(r['next'],[THREAD+'page-3'])
    def test_quoted_media_is_not_applicant_evidence(self):
        html=HTML.replace('Other applicant:','<img src="/quoted.png"> Other applicant:')
        r=parse_html(html,THREAD,'sdn:42','one')
        self.assertEqual(r['posts'][0]['images'],['https://forums.studentdoctor.net/attachments/a.png'])
    def test_md_relative_links_and_observed_pagination(self):
        html='<a href="profile/80001">applicant</a><input id="get_more_url" value="/search_more.php?search_app_date=2023-05-01"><input id="from_api" value="0">'
        r=parse_html(html,'https://www.mdapplicants.com/search_result.php?search_app_date=2023-05-01')
        self.assertEqual(r['records'][0]['accountKey'],'mdapplicants:80001')
        self.assertIn('psr=1',r['next'][0])
        second=parse_html('<a href="profile/80002">next</a>',r['next'][0])
        self.assertIn('psr=2',second['next'][0])
        end=parse_html('',second['next'][0]);self.assertTrue(end['endOfListing']);self.assertEqual(end['next'],[])
    def test_no_is_unknown_and_malformed_lists(self):
        r=parse_html(MD,'https://www.mdapplicants.com/profile/100')
        self.assertEqual([o['statuses'] for o in r['schoolObservations']],[['unknown'],['rejected']])
        self.assertIn('3.8',r['posts'][0]['text'])
    def test_challenge_not_data(self):
        with self.assertRaises(PermissionError):parse_html('<title>Just a moment...</title>',THREAD)
    def test_retry_after(self):
        self.assertEqual(retry_after('120',1000),1120)
        self.assertIsNone(retry_after('invalid',1000))
        self.assertEqual(retry_after('Thu, 01 Jan 1970 00:30:00 GMT',1000),1800)
    def test_storage_idempotency_and_corruption(self):
        with tempfile.TemporaryDirectory() as d:
            s=Store(d);key=s.enqueue(THREAD,'fixture','sdn:42','one')
            digest=s.capture(key,HTML.encode(),'2026-09-10','test')
            s.parse(key);s.capture(key,HTML.encode(),'2026-09-10','test');s.parse(key)
            self.assertEqual(s.db.execute('SELECT COUNT(*) FROM capture').fetchone()[0],1)
            self.assertEqual(s.status()['sources']['sdn']['parsedAccounts'],1)
            self.assertEqual(s.status()['newImportedAccounts'],0)
            self.assertEqual(s.status()['reviewsByDecision'],{})
            self.assertEqual(s.db.execute('SELECT COUNT(*) FROM frontier').fetchone()[0],2)
            a=s.db.execute('SELECT path FROM artifact WHERE hash=?',(digest,)).fetchone()[0]
            (Path(d)/a).write_text('tampered')
            with self.assertRaises(ValueError):s.parse(key,True)
    def test_disabled_network(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(PermissionError):Fetcher(Store(d)).request(THREAD)
    def test_seed_cannot_roll_back_new_capture(self):
        with tempfile.TemporaryDirectory() as d:
            s=Store(d);key=s.enqueue(THREAD,'fixture','sdn:42','one')
            fresh=s.capture(key,HTML.encode(),'2026-09-10','network_retrieval')
            s.capture(key,HTML.replace('515','514').encode(),'2026-09-07','legacy_audit_date_not_http_timestamp')
            self.assertEqual(s.row(key)['current_hash'],fresh)
            self.assertEqual(s.db.execute('SELECT COUNT(*) FROM capture').fetchone()[0],2)
    def test_long_rate_wait_does_not_reserve_repeated_slots(self):
        with tempfile.TemporaryDirectory() as d:
            s=Store(d);deadline=time.time()+100
            s.db.execute('INSERT INTO host_state(host,next_request) VALUES(?,?)',('forums.studentdoctor.net',deadline));s.db.commit()
            f=Fetcher(s)
            self.assertEqual(f.host_wait('forums.studentdoctor.net'),deadline)
            self.assertEqual(f.host_wait('forums.studentdoctor.net'),deadline)
    def test_claim_recovers_expired_lease(self):
        with tempfile.TemporaryDirectory() as d:
            s=Store(d);key=s.enqueue(THREAD,'fixture');r=s.claim();self.assertEqual(r['status'],'fetching')
            self.assertIsNone(s.claim())
            s.db.execute('UPDATE frontier SET lease_until=? WHERE key=?',(time.time()-1,key));s.db.commit()
            self.assertEqual(s.claim()['key'],key)
if __name__=='__main__':unittest.main()
