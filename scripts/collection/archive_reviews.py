"""Freeze cached review decisions/cost ledger as private content-addressed audit bundles."""
import argparse,base64,gzip,hashlib,json,sqlite3,tempfile
from pathlib import Path
from archive import immutable
from collector import encode,atomic_text
from run_annotation import PROCESS_VERSION

def archive_reviews(state,out,raw_manifest):
 queue=state/'review-queue.jsonl'
 if queue.exists():
  for line in queue.read_text().splitlines():
   row=json.loads(line)
   if row['inCreationScope'] and not row['baselineImported']:
    target=state/'field-reviews'/((state/row['path']).stem+'-'+PROCESS_VERSION+'.json')
    if not target.exists():raise ValueError('Annotation queue is unfinished; review archive cannot be frozen')
 with sqlite3.connect('file:'+str((state/'api-budget.sqlite').resolve())+'?mode=ro',uri=True) as db:
  if db.execute("SELECT COUNT(*) FROM api_usage WHERE status='reserved'").fetchone()[0]:raise ValueError('An annotation call is still reserved/in flight')
 report=json.loads(raw_manifest.read_text());objects=[];records=[];entries=[];size=0
 def flush():
  nonlocal entries,size
  if not entries:return
  plain=b''.join(body for _,body in entries);compressed=gzip.compress(plain,compresslevel=9,mtime=0);digest=hashlib.sha256(compressed).hexdigest();key='corpus/out11-2026-09-10/review-audit/'+digest+'.jsonl.gz';file=out/(digest+'.jsonl.gz');immutable(file,compressed)
  objects.append({'key':key,'file':str(file.resolve()),'sha256':digest,'bytes':len(compressed),'kind':'review_audit','records':len(entries),'uncompressedBytes':len(plain)})
  offset=0
  for ident,body in entries:
   records.append({'recordId':ident,'bundleKey':key,'bundleSha256':digest,'byteOffset':offset,'byteLength':len(body),'recordSha256':hashlib.sha256(body).hexdigest()});offset+=len(body)
  entries=[];size=0
 def add(relative,body):
  nonlocal entries,size
  envelope=(encode({'path':relative,'sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body),'contentBase64':base64.b64encode(body).decode()})+'\n').encode()
  if size and size+len(envelope)>32*1024*1024:flush()
  entries.append((relative,envelope));size+=len(envelope)
 for directory in ['review-packs','annotations','semantic-reviews','field-reviews']:
  for file in sorted((state/directory).glob('*.json')):add(str(file.relative_to(state)),file.read_bytes())
 for name in ['checkpoint.json','annotation-checkpoint.json','normalization-checkpoint.json','source-review-overrides.json','source-context-audit.json','release-review-report.json','recovery-provenance.json']:
  if (state/name).exists():add(name,(state/name).read_bytes())
 with tempfile.TemporaryDirectory() as temp:
  source=sqlite3.connect('file:'+str((state/'api-budget.sqlite').resolve())+'?mode=ro',uri=True);target=sqlite3.connect(str(Path(temp)/'budget.sqlite'));source.backup(target);target.close();source.close();add('api-budget.sqlite',(Path(temp)/'budget.sqlite').read_bytes())
 flush();report['objects']+=objects;report['records']+=records;report['reviewAuditRecords']=len(records)
 atomic_text(out/'release-artifact-manifest.json',json.dumps(report,indent=2)+'\n');return report
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state',required=True);p.add_argument('--output',required=True);p.add_argument('--raw-manifest',required=True);a=p.parse_args();r=archive_reviews(Path(a.state),Path(a.output),Path(a.raw_manifest));print(encode({'objects':len(r['objects']),'reviewAuditRecords':r['reviewAuditRecords']}))
