"""Read-only guard for numeric academic facts whose identity was lost with quotes.

Quoted text remains separately attributed context, never applicant-authored facts.
No model calls, repacking, persisted mutations, or metric reassignment occur here.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sqlite3
from pathlib import Path
from urllib.parse import urlsplit
from parsers import Tree

VERSION = 'out11-source-context-1'
NUMERIC_METRICS = {'gpa', 'scienceGpa', 'mcat'}
LABEL = re.compile(
    r'(?P<science>\bs\s*\.?\s*gpa\b|\bscience\s*(?:gpa|grade\s*point\s*average)\b|\bbcp[m]?\s*(?:gpa)?\b)'
    r'|(?P<cumulative>\bc\s*\.?\s*gpa\b|\b(?:cumulative|overall|undergrad(?:uate)?)\s*(?:gpa|grade\s*point\s*average)\b|\bugpa\b)'
    r'|(?P<mcat>\bmcat\b)'
    r'|(?P<generic>\bgpa\b|\bgrade\s*point\s*average\b)', re.I)


def metric_labels(text):
    return [{'metric': {'science':'scienceGpa', 'cumulative':'gpa', 'mcat':'mcat', 'generic':'gpa_unspecified'}[m.lastgroup],
             'label':m.group(), 'start':m.start(), 'end':m.end()} for m in LABEL.finditer(text)]


def _local_labels(text, quote):
    """Labels in the exact witness or its own sentence, never unrelated replies."""
    start=text.find(quote)
    if start<0:return []
    end=start+len(quote)
    left=0;right=len(text)
    # Do not split a decimal GPA at its decimal point.
    for m in re.finditer(r'(?<!\d)[.!?]|[.!?](?!\d)',text):
        if m.end()<=start:left=m.end()
        elif m.start()>=end:right=m.start();break
    return metric_labels(text[max(left,start-140):min(right,end+140)])


class SourceContextError(ValueError):
    pass


class SourceContextStore:
    """A read-only manifest/immutable capture reader, cache scoped to this instance."""
    def __init__(self,state):
        self.root=Path(state).resolve()
        self.db=sqlite3.connect((self.root/'manifest.sqlite').as_uri()+'?mode=ro',uri=True)
        self.db.row_factory=sqlite3.Row
        self.cache={}
    def close(self):self.db.close()
    def __enter__(self):return self
    def __exit__(self,*args):self.close()
    def _capture(self,digest):
        if not isinstance(digest,str) or not re.fullmatch(r'[0-9a-f]{64}',digest):raise SourceContextError('invalid_capture_hash')
        if digest in self.cache:return self.cache[digest]
        row=self.db.execute('SELECT path,bytes FROM artifact WHERE hash=?',(digest,)).fetchone()
        if not row:raise SourceContextError('capture_missing_from_manifest')
        path=(self.root/row['path']).resolve()
        if not path.is_relative_to(self.root/'artifacts'):raise SourceContextError('capture_path_outside_artifacts')
        try:raw=path.read_bytes()
        except OSError as error:raise SourceContextError('capture_unreadable') from error
        if len(raw)!=row['bytes'] or hashlib.sha256(raw).hexdigest()!=digest:raise SourceContextError('capture_digest_mismatch')
        tree=Tree(raw.decode('utf-8',errors='replace')).root
        posts={}
        for article in tree.findall(lambda n:n.tag=='article' and n.has('message--post')):
            pid=article.attrs.get('data-content') or article.attrs.get('id')
            body=article.first(lambda n:n.has('bbWrapper'))
            user=article.first(lambda n:n.tag=='a' and n.has('username'))
            if not pid or not body:continue
            if pid in posts:raise SourceContextError('duplicate_post_id_in_capture')
            posts[pid]={'article':article,'body':body,'uid':user.attrs.get('data-user-id') if user else None,
                        'author':article.attrs.get('data-author'),'text':body.text()}
        self.cache[digest]=posts
        return posts
    def post_context(self,post,account_key):
        digest=post.get('sourceArtifactSha256');posts=self._capture(digest)
        p=posts.get(post.get('postId'))
        if p is None:raise SourceContextError('post_missing_from_capture')
        if account_key.startswith('sdn:deleted-handle:'):
            if (p['author'] or '').lower()!=account_key.removeprefix('sdn:deleted-handle:'):raise SourceContextError('source_author_mismatch')
        elif p['uid']!=account_key.removeprefix('sdn:'):raise SourceContextError('source_author_mismatch')
        if p['text']!=post.get('text'):raise SourceContextError('author_text_mismatch')
        url=urlsplit(post.get('sourceUrl',''))
        if url.scheme!='https' or url.hostname!='forums.studentdoctor.net' or url.fragment!=post['postId']:raise SourceContextError('source_url_mismatch')
        linked=self.db.execute('SELECT 1 FROM post WHERE account_key=? AND post_id=? AND hash=? AND source_url=?',
                              (account_key,post['postId'],digest,post['sourceUrl'])).fetchone()
        if not linked:raise SourceContextError('post_manifest_link_mismatch')
        result=[]
        for q in p['body'].findall(lambda n:n.tag=='blockquote'):
            content=q.first(lambda n:n.has('bbCodeBlock-expandContent')) or q.first(lambda n:n.has('bbCodeBlock-content')) or q
            # Nested quotations get their own attribution entry, not the parent's.
            text=content.text(skip=('script','style','blockquote')) if content is not q else ' '.join(
                c if isinstance(c,str) else c.text(skip=('script','style','blockquote')) for c in q.children)
            text=re.sub(r'\s+',' ',text).strip()
            source=re.fullmatch(r'post:\s*(\d+)',q.attrs.get('data-source',''))
            pid='post-'+source[1] if source else None
            member=re.search(r'\bmember:\s*(\d+)\b',q.attrs.get('data-attributes',''))
            original=posts.get(pid)
            result.append({'kind':'attributed_quote_context_only','author':q.attrs.get('data-quote'),
                           'authorUid':member[1] if member else None,'sourcePostId':pid,'text':text,
                           'attributionVerifiedInCapture':bool(original and original['author']==q.attrs.get('data-quote')
                               and (not member or original['uid']==member[1]) and text and text in original['text'])})
        return result


def academic_context_gate(facts,pack,approved_fields,store):
    """Return blocked IDs only; never change a source field or infer a replacement.

    Any numeric identity dependent on excluded academic quote context is blocked,
    even if a single quoted question agrees, until normalized evidence preserves
    that attribution. Explicit, appropriately labeled author statements survive.
    Missing/corrupt provenance fails closed for these otherwise unlabeled fields.
    """
    out={'version':VERSION,'blockedFields':[],'findings':[],'checkedFields':0}
    if not pack.get('accountKey','').startswith('sdn:'):return out
    approved=set(approved_fields)
    for i,row in enumerate(facts.get('academics',[])):
        fid=f'academics:{i}'
        if fid not in approved or not isinstance(row,list) or len(row)!=4:continue
        metric,value,index,quote=row
        if metric not in NUMERIC_METRICS or not re.fullmatch(r'\d+(?:\.\d+)?',value or ''):continue
        if not isinstance(index,str) or not index.isdigit() or not 1<=int(index)<=len(pack['posts']):continue
        post=pack['posts'][int(index)-1]
        own=_local_labels(post['text'],quote)
        own_types={m['metric'] for m in own}
        all_own_types={m['metric'] for m in metric_labels(post['text'])}
        # A reply that explicitly discusses only one academic metric may place
        # its value in the following sentence ('My score is ...'). That does
        # not require the excluded question to establish the metric identity.
        if all_own_types=={metric}:continue
        # A specific label in this author's witness/sentence does not need a quote.
        if metric in own_types:continue
        out['checkedFields']+=1
        base={'fieldID':fid,'selectedMetric':metric,'value':value,'sourcePostId':post['postId'],
              'sourceUrl':post['sourceUrl'],'sourceArtifactSha256':post['sourceArtifactSha256'],
              'authorReply':post['text'],'exactWitness':quote,'ownMetricLabels':own}
        try:contexts=store.post_context(post,pack['accountKey'])
        except (SourceContextError,sqlite3.Error,OSError) as error:
            out['blockedFields'].append(fid);out['findings'].append({**base,'code':'academic_context_provenance_unavailable',
                    'detail':str(error) if isinstance(error,SourceContextError) else type(error).__name__,'quotedContexts':[]})
            continue
        relevant=[{**q,'academicLabels':metric_labels(q['text'])} for q in contexts if metric_labels(q['text'])]
        if not relevant:continue
        types={m['metric'] for q in relevant for m in q['academicLabels']}
        # Generic 'GPA' is an author's reported GPA label, but cannot overrule a
        # quoted question that specifically asks for science GPA or another test.
        if metric=='gpa' and 'gpa_unspecified' in own_types and types<={'gpa','gpa_unspecified'}:continue
        if len(types)>1:code='academic_context_ambiguous_identity'
        elif metric in types or (metric=='gpa' and types=={'gpa_unspecified'}):code='academic_identity_depends_on_excluded_context'
        else:code='academic_context_metric_mismatch'
        out['blockedFields'].append(fid)
        out['findings'].append({**base,'code':code,'inferredQuestionMetrics':sorted(types),'quotedContexts':relevant})
    return out


def audit_cached(state):
    """Inspect every immutable cached review version, including superseded ones."""
    state=Path(state);report={'version':VERSION,'reviewFiles':0,'approvedNumericFields':0,'checkedContextFields':0,
                             'affectedReviews':[],'errors':[],'scope':'All cached field-review versions; not all are active normalized candidates.'}
    paths=sorted((state/'field-reviews').glob('*.json'))
    with SourceContextStore(state) as store:
        for path in paths:
            try:
                review=json.loads(path.read_text())
                if review.get('reviewStatus')!='field_reviewed_candidate':continue
                pack=json.loads(Path(review['packPath']).read_text());extract=json.loads(Path(review['extractionPath']).read_text())
                if pack['contentDigest']!=review['contentDigest'] or extract['contentDigest']!=review['contentDigest']:raise ValueError('source_revision_mismatch')
                facts=extract['facts'];approved=review.get('supportedFields',[])
                report['reviewFiles']+=1
                report['approvedNumericFields']+=sum(f'academics:{i}' in approved and len(r)==4 and r[0] in NUMERIC_METRICS for i,r in enumerate(facts.get('academics',[])))
                result=academic_context_gate(facts,pack,approved,store);report['checkedContextFields']+=result['checkedFields']
                if result['findings']:report['affectedReviews'].append({'reviewPath':str(path),'accountKey':pack['accountKey'],
                         'contentDigest':pack['contentDigest'],'processVersion':review.get('processVersion'),**result})
            except (ValueError,KeyError,OSError,sqlite3.Error) as error:report['errors'].append({'reviewPath':str(path),'error':str(error)})
    report['affectedUniqueFields']=len({(a['accountKey'],a['contentDigest'],f['fieldID']) for a in report['affectedReviews'] for f in a['findings']})
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--state',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    report=audit_cached(args.state);path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
    print(json.dumps({k:v for k,v in report.items() if k not in {'affectedReviews','errors'}}|{'errors':len(report['errors']),'report':str(path)}))
