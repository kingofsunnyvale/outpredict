"""Reapply current deterministic gates/approved source corrections to cached calls only."""
import argparse,json
from pathlib import Path
from run_annotation import process,PROCESS_VERSION,checkpoint

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state',required=True);p.add_argument('--account',action='append');a=p.parse_args();state=Path(a.state)
 rows=[json.loads(line) for line in (state/'review-queue.jsonl').read_text().splitlines()]
 before=json.loads((state/'annotation-checkpoint.json').read_text())['budget'] if (state/'annotation-checkpoint.json').exists() else None
 counts={}
 for row in rows:
  if row['baselineImported'] or not row['inCreationScope'] or (a.account and row['accountKey'] not in a.account):continue
  target=state/'field-reviews'/((state/row['path']).stem+'-'+PROCESS_VERSION+'.json')
  if not target.exists() or json.loads(target.read_text())['reviewStatus'] not in ['field_reviewed_candidate','excluded_no_supported_fields']:continue
  result=process(row,state,Path('/nonexistent-offline-credentials'),cached_only=True,force=True);key=result['reviewStatus'];counts[key]=counts.get(key,0)+1
 print(json.dumps({'revalidated':counts,'networkCalls':0}));checkpoint(state)
