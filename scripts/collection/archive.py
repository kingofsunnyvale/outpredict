"""Freeze private raw-source artifacts and a reproducible provenance manifest offline."""
import argparse,base64,gzip,hashlib,json,sqlite3
from pathlib import Path
from collector import encode,atomic_text

def immutable(path,body):
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 if path.exists():
  if path.read_bytes()!=body:raise ValueError('Content-addressed artifact changed')
 else:path.write_bytes(body);path.chmod(0o600)

def archive(state,out,chunk_bytes=32*1024*1024):
 db=sqlite3.connect('file:'+str((state/'manifest.sqlite').resolve())+'?mode=ro',uri=True);db.row_factory=sqlite3.Row;db.execute('BEGIN')
 tables=['config','discovery','frontier','artifact','capture','parse','post','attempt','review','baseline_import','host_state']
 manifest={'version':1,'offsetUnit':'UTF-8 bytes in decompressed JSONL','tables':{table:[dict(row) for row in db.execute('SELECT * FROM '+table+' ORDER BY '+','.join(str(i+1) for i in range(len(db.execute('PRAGMA table_info('+table+')').fetchall()))))] for table in tables}}
 payload=(encode(manifest)+'\n').encode();manifest_hash=hashlib.sha256(payload).hexdigest();objects=[];locators=[]
 def bundle(entries,kind):
  if not entries:return
  plain=b''.join(body for _,body in entries);compressed=gzip.compress(plain,compresslevel=9,mtime=0);sha=hashlib.sha256(compressed).hexdigest();key='corpus/out11-2026-09-10/'+kind+'/'+sha+'.jsonl.gz';file=out/(sha+'.jsonl.gz');immutable(file,compressed)
  objects.append({'key':key,'file':str(file.resolve()),'sha256':sha,'bytes':len(compressed),'kind':kind,'records':len(entries),'uncompressedBytes':len(plain)})
  offset=0
  for ident,body in entries:
   locators.append({'recordId':ident,'bundleKey':key,'bundleSha256':sha,'byteOffset':offset,'byteLength':len(body),'recordSha256':hashlib.sha256(body).hexdigest()});offset+=len(body)
 entries=[];size=0
 for row in db.execute('SELECT * FROM artifact ORDER BY hash'):
  body=(state/row['path']).read_bytes()
  if hashlib.sha256(body).hexdigest()!=row['hash']:raise ValueError('Raw capture checksum mismatch')
  line=(encode({'sourceSha256':row['hash'],'sourceBytes':len(body),'contentBase64':base64.b64encode(body).decode()})+'\n').encode()
  if size and size+len(line)>chunk_bytes:bundle(entries,'raw');entries=[];size=0
  entries.append((row['hash'],line));size+=len(line)
 bundle(entries,'raw');bundle([(manifest_hash,payload)],'collection_manifest')
 report={'version':1,'collectionManifestSha256':manifest_hash,'rawArtifactCount':db.execute('SELECT COUNT(*) FROM artifact').fetchone()[0],'objects':objects,'records':locators}
 out.mkdir(parents=True,exist_ok=True,mode=0o700);atomic_text(out/'raw-artifact-manifest.json',json.dumps(report,indent=2)+'\n')
 atomic_text(state/'collection-provenance.json',payload.decode())
 db.close();return report
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state',required=True);p.add_argument('--output',required=True);a=p.parse_args();r=archive(Path(a.state),Path(a.output));print(encode({'rawArtifacts':r['rawArtifactCount'],'objects':len(r['objects']),'collectionManifestSha256':r['collectionManifestSha256']}))
