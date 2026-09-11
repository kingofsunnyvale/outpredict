import gzip,hashlib,json,tempfile,unittest,base64
from pathlib import Path
from collector import Store
from archive import archive
from archive_reviews import archive_reviews
from budget import Budget
class ArchiveTests(unittest.TestCase):
 def test_raw_bytes_and_review_ledger_roundtrip(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);state=root/'state';out=root/'out';s=Store(state);key=s.enqueue('https://forums.studentdoctor.net/threads/test.1/','synthetic','sdn:1','test');raw=b'<html>source</html>';digest=s.capture(key,raw,'2026-09-10','synthetic');s.close()
   report=archive(state,out,100)
   self.assertEqual(report['rawArtifactCount'],1)
   record=next(r for r in report['records'] if r['recordId']==digest);bundle=next(o for o in report['objects'] if o['key']==record['bundleKey']);plain=gzip.decompress(Path(bundle['file']).read_bytes());envelope=json.loads(plain[record['byteOffset']:record['byteOffset']+record['byteLength']]);self.assertEqual(base64.b64decode(envelope['contentBase64']),raw)
   b=Budget(state/'api-budget.sqlite');b.close();(state/'annotations').mkdir();(state/'annotations'/'test.json').write_text('{"facts":[]}')
   combined=archive_reviews(state,out,out/'raw-artifact-manifest.json');self.assertEqual(combined['reviewAuditRecords'],2)
   audit=next(r for r in combined['records'] if r['recordId']=='annotations/test.json');obj=next(o for o in combined['objects'] if o['key']==audit['bundleKey']);body=gzip.decompress(Path(obj['file']).read_bytes())[audit['byteOffset']:audit['byteOffset']+audit['byteLength']];self.assertEqual(hashlib.sha256(body).hexdigest(),audit['recordSha256'])
   self.assertEqual(base64.b64decode(json.loads(body)['contentBase64']),b'{"facts":[]}')
if __name__=='__main__':unittest.main()
