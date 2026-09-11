"""Build lossless account review packs; no automatic profile qualification/import."""
import argparse, hashlib, json, re
from pathlib import Path
from collector import Store, atomic_text, encode, now
from parsers import candidates

EXPLICIT=re.compile(r'\b(?:I|we) (?:was|got|have been|received|had) [^.\n]{0,35}(?:accept|reject)|\b(?:acceptances|rejections|rejected (?:from|by)|accepted (?:to|at|into))\b',re.I)
def pack_accounts(store):
    baseline={r[0] for r in store.db.execute('SELECT DISTINCT account_key FROM baseline_import')}
    accounts=[r[0] for r in store.db.execute('SELECT DISTINCT account_key FROM post ORDER BY account_key')]
    queue=[]
    for account in accounts:
        rows=list(store.db.execute('''SELECT p.*,f.url,f.in_scope,f.handle,c.observed_at FROM post p JOIN frontier f ON f.key=p.key AND f.current_hash=p.hash
          JOIN capture c ON c.key=p.key AND c.hash=p.hash WHERE p.account_key=?
          GROUP BY p.source,p.post_id,p.hash ORDER BY p.authored_at,p.post_id''',(account,)))
        if not rows:continue
        text='\n\n'.join(r['text'] for r in rows)
        digest=hashlib.sha256(encode([(r['post_id'],r['hash'],r['text']) for r in rows]).encode()).hexdigest()
        artifact=dict(accountKey=account,publicHandle=next((r['handle'] for r in rows if r['handle']),None),builtAt=now(),contentDigest=digest,
          scope={'anyThreadInCreationScope':any(r['in_scope'] for r in rows),'hasRecentAuthoredUpdate':any((r['authored_at'] or '')[:10]>='2023-05-01' for r in rows)},
          baselineImported=account in baseline,reviewStatus='not_reviewed_by_this_pipeline',
          posts=[{'postId':r['post_id'],'authoredAt':r['authored_at'],'observedAt':r['observed_at'],'sourceUrl':r['source_url'],'sourceArtifactSha256':r['hash'],'text':r['text'],'images':json.loads(r['images'])} for r in rows],
          hints=candidates(text),previousReviews=[dict(r) for r in store.db.execute('SELECT basis,decision,reviewed_at,notes,input_hashes FROM review WHERE account_key=?',(account,))],
          requiredReview={'gpa':None,'scienceGpa':None,'mcat':None,'cycle':None,'activities':[],'outcomes':[],'missingness':[],'timingNotes':[],'qualificationTier':None,'decision':None,'reviewer':None})
        rel=Path('review-packs')/(re.sub(r'[^a-zA-Z0-9_-]','_',account)+'-'+digest[:12]+'.json')
        atomic_text(store.root/rel,json.dumps(artifact,indent=2,ensure_ascii=False)+'\n')
        hints=artifact['hints'];score=len(EXPLICIT.findall(text))*4 + min(hints['gpa']['mentionCount'],1)+min(hints['mcat']['mentionCount'],1)+min(hints['activity']['mentionCount'],6)
        queue.append({'accountKey':account,'path':str(rel),'chars':len(text),'posts':len(rows),'hintsOnlyPriority':score,'baselineImported':account in baseline,'inCreationScope':artifact['scope']['anyThreadInCreationScope'],'hasRecentUpdate':artifact['scope']['hasRecentAuthoredUpdate'],'contentDigest':digest})
    queue.sort(key=lambda r:(r['baselineImported'],not r['inCreationScope'],-r['hintsOnlyPriority'],r['accountKey']))
    atomic_text(store.root/'review-queue.jsonl',''.join(encode(r)+'\n' for r in queue))
    print(encode({'reviewPacks':len(queue),'notAlreadyImported':sum(not r['baselineImported'] for r in queue),'reviewedNewAccounts':0,'note':'Hints are lexical triage only; no new qualifying or imported accounts claimed.'}))
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--state',default=str(Path(__file__).parent/'state'));args=parser.parse_args();pack_accounts(Store(args.state))
