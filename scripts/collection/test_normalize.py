import json,tempfile,unittest,hashlib
from pathlib import Path
from normalize import measurement,academic_measurement,normalize,snapshot_metadata
from validation import validate
from run_annotation import prepare_extraction

class NormalizeTests(unittest.TestCase):
 def test_creation_cutoff_does_not_backdate_fresh_recovery_captures(self):
  from collector import Store
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);store=Store(root)
   store.db.execute('INSERT INTO config VALUES(?,?)',('scope',json.dumps({'startDate':'2023-05-01','asOf':'2026-09-10T03:03:00Z'})))
   store.db.execute('INSERT INTO config VALUES(?,?)',('recoveryRun',json.dumps({'collectionId':'out11-2026-09-11-recovery','priorInterruptedRun':{'ledgerRecovered':False,'historicalAuthorizedCeilingUsd':95}})));store.db.commit()
   key=store.enqueue('https://forums.studentdoctor.net/threads/test.1/','fixture')
   store.capture(key,b'cache','2026-09-07','legacy_audit_date_not_http_timestamp')
   store.capture(key,b'fresh','2026-09-11T02:30:00Z','network_retrieval');store.close()
   metadata=snapshot_metadata(root)
   self.assertEqual(metadata['collectionAsOf'],'2026-09-11T02:30:00Z')
   self.assertEqual(metadata['creationScope']['asOf'],'2026-09-10T03:03:00Z')
   self.assertEqual(metadata['release'],'out11-2026-09-11-recovery-reviewed-expansion')
   self.assertEqual(metadata['captureObservationRange']['observationBasisCounts'],{'legacy_audit_date_not_http_timestamp':1,'network_retrieval':1})
 def test_durations_never_become_hours(self):
  self.assertEqual(measurement('3 years','Resident Assistant for 3 years')['precision'],'unreported')
  self.assertEqual(measurement('50ish hours','50ish hours'),{'min':50,'max':50,'precision':'approximate'})
  self.assertEqual(measurement('100-200 hours','100-200 hours')['precision'],'range')
  self.assertEqual(measurement('none','no research, none')['precision'],'explicit_absence')
 def academic(self,text,value):
  p={'postId':'p1','sourceArtifactSha256':'a'*64,'text':text}
  span={'postId':'p1','sourceArtifactSha256':'a'*64,'quote':text,'start':0,'end':len(text)}
  return academic_measurement(value,span,{'posts':[p]})
 def test_mcat_sections_or_attempts_are_not_ranges(self):
  for text,value in [('MCAT 503-125,125,125,128','503'),('MCAT 515 - 128/129/128/130','515'),('MCAT 511 - 1 attempt','511')]:
   self.assertEqual(self.academic(text,value),{'min':float(value),'max':float(value),'precision':'reported'})
 def test_academic_precision_is_preserved(self):
  self.assertEqual(self.academic('GPA 3.3–3.4','3.3'),{'min':3.3,'max':3.4,'precision':'range'})
  self.assertEqual(self.academic('GPA ~3.34','3.34')['precision'],'approximate')
  self.assertEqual(self.academic('GPA 3.34ish','3.34')['precision'],'approximate')
  self.assertEqual(self.academic('GPA >3.4','3.4')['precision'],'lower_bound')
 def test_science_gpa_only_is_useful_and_snapshot_id_is_stable(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);text='sGPA: 3.61';pack={'accountKey':'sdn:1','contentDigest':'b'*64,'publicHandle':'synthetic','scope':{},'posts':[{'postId':'p1','sourceArtifactSha256':'a'*64,'text':text,'sourceUrl':'https://forums.studentdoctor.net/threads/test.1/#p1','authoredAt':None,'observedAt':'2026-09-10T00:00:00Z'}]}
   facts={'cycle':'','cycleEvidence':[],'academics':[['scienceGpa','3.61','1',text]],'activities':[],'outcomes':[],'notes':[]}
   pack_path=root/'pack.json';pack_path.write_text(json.dumps(pack));extract=root/'extract.json';extract.write_text(json.dumps({'facts':facts,'contentDigest':pack['contentDigest']}))
   field={'reviewStatus':'field_reviewed_candidate','packPath':str(pack_path),'extractionPath':str(extract),'contentDigest':pack['contentDigest'],'supportedFields':['academics:0'],'narrativeOnlyFields':[],'omittedFields':{},'reviewedAt':'2026-09-10T00:00:00Z','method':'model_extraction_and_exact_source_validation'}
   p=normalize(field,root/'artifacts');self.assertEqual(p['scienceGpa'],3.61);self.assertEqual(p['gpa'],None);self.assertEqual(p['version'],1);self.assertEqual(p['evidenceTier'],'reviewed_profile')
   field['reviewedAt']='2026-09-11T00:00:00Z';q=normalize(field,root/'artifacts');self.assertEqual(p['id'],q['id'])
 def test_exact_witness_swap_repairs_without_mutating_model_output(self):
  with tempfile.TemporaryDirectory() as d:
   quote='Volunteer 50 hours';pack={'posts':[{'text':quote,'postId':'p1','sourceUrl':'https://example.invalid','sourceArtifactSha256':'a'*64,'authoredAt':None}]}
   facts={'cycle':'','cycleEvidence':[],'academics':[],'activities':[['nonclinical','Volunteer','50 hours','completed_reported',quote,'1']],'outcomes':[],'notes':[]};raw={'facts':facts}
   fixed,_=prepare_extraction(raw,pack,Path(d)/'original.json');self.assertEqual(fixed['facts']['activities'][0][-2:],['1',quote]);self.assertEqual(raw['facts']['activities'][0][-2:],[quote,'1']);self.assertEqual(validate(fixed['facts'],pack)['errors'],[])
if __name__=='__main__':unittest.main()

class QuantitySalvageTests(unittest.TestCase):
 def test_explicit_completed_quantity_is_not_sum_of_current_and_anticipated(self):
  from normalize import completed_component
  quote='947 completed hours with 771 anticipated'
  self.assertEqual(completed_component(quote,quote),'947 hours')
  self.assertEqual(completed_component('171 completed + 100 anticipated','171 completed hours + 100 anticipated'),'171 hours')
  self.assertIsNone(completed_component('300 completed and 300 anticipated','300 completed and 300 anticipated'))
  self.assertIsNone(completed_component('300 clinical and 200 shadowing','300 clinical hours and 200 shadowing hours'))
 def test_unique_exact_quote_can_recover_missing_index_without_changing_timing(self):
  with tempfile.TemporaryDirectory() as d:
   quote='Patient navigator: 75 hours';pack={'posts':[{'text':quote,'postId':'p1','sourceUrl':'https://example.invalid','sourceArtifactSha256':'a'*64,'authoredAt':None}]}
   facts={'cycle':'','cycleEvidence':[],'academics':[],'activities':[['clinical','Patient navigator','75 hours','completed_reported',quote,'planned']],'outcomes':[],'notes':[]};raw={'facts':facts}
   fixed,_=prepare_extraction(raw,pack,Path(d)/'original.json')
   self.assertEqual(fixed['facts']['activities'][0][3:],[ 'completed_reported','1',quote]);self.assertEqual(raw['facts']['activities'][0][-1],'planned')
 def test_ambiguous_quote_cannot_recover_an_index(self):
  with tempfile.TemporaryDirectory() as d:
   quote='Patient navigator: 75 hours';pack={'posts':[{'text':quote+' '+quote,'postId':'p1','sourceUrl':'https://example.invalid','sourceArtifactSha256':'a'*64,'authoredAt':None}]}
   raw={'facts':{'cycle':'','cycleEvidence':[],'academics':[],'activities':[['clinical','Patient navigator','75 hours','completed_reported',quote,'']],'outcomes':[],'notes':[]}}
   fixed,_=prepare_extraction(raw,pack,Path(d)/'original.json');self.assertEqual(fixed['facts']['activities'][0][-1],'')
