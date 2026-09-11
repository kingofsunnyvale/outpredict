"""Create normalized release candidates from approved fields; never deploy/import."""
import argparse,hashlib,json,re,sqlite3
from pathlib import Path
from collector import atomic_text,encode,now
from run_annotation import PROCESS_VERSION
from validation import validate,_numbers,_precision
from source_context import SourceContextStore,academic_context_gate

def snapshot_metadata(state):
    """Separate the creation window from the actual mixed-cache capture dates."""
    frozen=state/'collection-provenance.json'
    if frozen.exists():
        tables=json.loads(frozen.read_text())['tables']
        config={row['key']:json.loads(row['value']) for row in tables['config']}
        captures=tables['capture']
    else:
        with sqlite3.connect('file:'+str((state/'manifest.sqlite').resolve())+'?mode=ro',uri=True) as db:
            db.row_factory=sqlite3.Row;db.execute('BEGIN')
            config={row['key']:json.loads(row['value']) for row in db.execute('SELECT * FROM config')}
            captures=[dict(row) for row in db.execute('SELECT * FROM capture')]
    scope=config.get('scope',{})
    dates=sorted(row['observed_at'] for row in captures)
    if not dates:raise ValueError('Cannot date a collection snapshot without source captures')
    recovery=config.get('recoveryRun')
    identity=recovery['collectionId'] if recovery else 'out11-'+dates[-1][:10]
    network=sorted(row['observed_at'] for row in captures if row['observation_basis']=='network_retrieval')
    return {'release':identity+'-reviewed-expansion','creationScope':scope,'collectionAsOf':dates[-1],
      'captureObservationRange':{'earliest':dates[0],'latest':dates[-1],
        'firstNetworkRetrieval':network[0] if network else None,'lastNetworkRetrieval':network[-1] if network else None,
        'observationBasisCounts':{basis:sum(row['observation_basis']==basis for row in captures) for basis in sorted({row['observation_basis'] for row in captures})}},
      'recoveryRun':recovery}

def completed_component(raw,quote):
    number=r'(?:[~≈]|(?:about|around|approximately|close to|nearly|almost)\s+)?\d[\d,]*(?:\.\d+)?'
    pattern=re.compile(r'('+number+r')\s*(?:(?:completed|current)(?:\s*(?:hours?|hrs?))?|(?:hours?|hrs?)\s*(?:completed|current))',re.I)
    proposed=list(pattern.finditer(raw));source=list(pattern.finditer(quote))
    if len(proposed)!=1 or len(source)!=1 or not re.search(r'(?<![a-z])(?:hours?|hrs?)\b',quote,re.I):return None
    a=_numbers(proposed[0][1]);b=_numbers(source[0][1])
    if len(a)!=1 or len(b)!=1 or a[0][0]!=b[0][0]:return None
    return source[0][1]+' hours'

def source_measurement(raw,span,pack):
    component=completed_component(raw,span['quote'])
    if component:return measurement(component,span['quote'])
    h=measurement(raw,span['quote'])
    values=_numbers(raw)
    if len(values)!=1:return h
    number=values[0][0];matches=[(a,b) for n,a,b in _numbers(span['quote']) if n==number]
    if len(matches)!=1:return h
    post=next(p for p in pack['posts'] if p['postId']==span['postId'] and p['sourceArtifactSha256']==span['sourceArtifactSha256'])
    a,b=matches[0];before=post['text'][max(0,span['start']+a-60):span['start']+a];after=post['text'][span['start']+b:span['start']+b+40]
    precision=_precision(before,after);n=float(number.replace(',',''))
    if precision=='approximate':return {'min':n,'max':n,'precision':'approximate'}
    if precision.startswith('lower'):return {'min':n,'max':None,'precision':'lower_bound'}
    if precision.startswith('upper'):return {'min':None,'max':n,'precision':'upper_bound'}
    return h

def measurement(raw,quote,narrative_only=False):
    empty={'min':None,'max':None,'precision':'unreported'}
    if narrative_only or not raw:return empty
    if re.search(r'\b(?:years?|months?|semesters?|weeks?|days?)\b',raw,re.I) and not re.search(r'\b(?:hours?|hrs?)\b',raw,re.I):return empty
    values=_numbers(raw)
    if not values:
        if re.fullmatch(r'\s*(?:none|zero|no(?:\s+hours)?)\s*',raw,re.I) and raw.strip().lower() in quote.lower():
            return {'min':0,'max':0,'precision':'explicit_absence'}
        return empty
    nums=[float(x[0].replace(',','')) for x in values]
    if len(values)==2 and re.search(r'[-–—]|\bto\b',raw[values[0][2]:values[1][1]]):
        return {'min':min(nums),'max':max(nums),'precision':'range'}
    if len(values)!=1:return empty
    number,start,end=values[0];n=nums[0];precision=_precision(raw[:start],raw[end:])
    if precision=='approximate':kind='approximate';lo=hi=n
    elif precision.startswith('lower') or re.search(r'and counting|or more',raw,re.I):kind='lower_bound';lo=n;hi=None
    elif precision.startswith('upper'):kind='upper_bound';lo=None;hi=n
    else:kind='reported';lo=hi=n
    return {'min':lo,'max':hi,'precision':kind}

def academic_measurement(value,span,pack):
    """Preserve source precision around this academic token, not a nearby value."""
    post=next(p for p in pack['posts'] if p['postId']==span['postId'] and p['sourceArtifactSha256']==span['sourceArtifactSha256'])
    source=post['text'];quote=span['quote'];matches=[(a,b) for n,a,b in _numbers(quote) if n.replace(',','')==value]
    if not matches:return {'min':None,'max':None,'precision':'unreported'}
    a,b=matches[0];start=span['start']+a;end=span['start']+b;n=float(value)
    before=source[max(0,start-40):start];after=source[end:end+50]
    # Only a directly adjacent range connector qualifies a second endpoint.
    next_range=re.match(r'\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?)',after,re.I)
    prev_range=re.search(r'(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*$',before,re.I)
    same_domain=lambda value: (472<=value<=528 and value==int(value)) if n>=472 else 0<=value<=4
    if next_range and same_domain(float(next_range[1])):return {'min':min(n,float(next_range[1])),'max':max(n,float(next_range[1])),'precision':'range'}
    if prev_range and same_domain(float(prev_range[1])):return {'min':min(n,float(prev_range[1])),'max':max(n,float(prev_range[1])),'precision':'range'}
    precision=_precision(before,after)
    if precision=='approximate' or re.match(r'\s*(?:ish\b|approximately\b|approx\b)',after,re.I):return {'min':n,'max':n,'precision':'approximate'}
    if precision.startswith('lower'):return {'min':n,'max':None,'precision':'lower_bound'}
    if precision.startswith('upper'):return {'min':None,'max':n,'precision':'upper_bound'}
    return {'min':n,'max':n,'precision':'reported'}

def normalize(field_review,artifact_dir,context_store=None):
    if field_review['reviewStatus']!='field_reviewed_candidate':return None
    pack=json.loads(Path(field_review['packPath']).read_text());extract=json.loads(Path(field_review['extractionPath']).read_text());facts=extract['facts'];checked=validate(facts,pack)
    if pack['contentDigest']!=field_review['contentDigest'] or extract['contentDigest']!=pack['contentDigest']:raise ValueError('Source revision mismatch')
    approved=set(field_review['supportedFields']);narrative=set(field_review.get('narrativeOnlyFields',[]))
    gate=academic_context_gate(facts,pack,approved,context_store) if context_store else {'blockedFields':[],'findings':[]}
    approved.difference_update(gate['blockedFields'])
    hard_fields=set()
    for error in checked['errors']:
        m=re.match(r'((?:academics|activities|outcomes):\d+|cycle)(?::|$)',error)
        if m:hard_fields.add(m[1])
        else:raise ValueError('Unresolved profile validation error')
    if approved & hard_fields:raise ValueError('Approved field no longer passes current deterministic validation')
    selected={};fieldmap={};uncertain=[];academic_measurements={}
    for i,row in enumerate(facts['academics']):
        fid=f'academics:{i}'
        if fid not in approved:continue
        key,value,_,_=row
        if key in selected and selected[key]!=value:
            uncertain.append(key);continue
        selected[key]=value;fieldmap[key]=fid
    for key in uncertain:selected.pop(key,None);fieldmap.pop(key,None)
    for key in ['gpa','scienceGpa','mcat']:
        academic_measurements[key]=academic_measurement(selected[key],checked['spans'][fieldmap[key]],pack) if key in selected else {'min':None,'max':None,'precision':'unreported'}
    cycle=facts['cycle'] if 'cycle' in approved else 'unknown'
    source,source_id=pack['accountKey'].split(':',1)
    profile_id=re.sub(r'[^a-z0-9_-]','-',source+'-'+source_id.lower()+'-'+cycle)
    activities=[];outcomes=[];evidence=[]
    for i,row in enumerate(facts['activities']):
        fid=f'activities:{i}'
        if fid not in approved and fid not in narrative:continue
        category,description,hours,timing,_,quote=row
        # Source references carry exact values; avoid burying duplicate hour
        # quantities in the role name that runtime temporal filtering preserves.
        description=re.sub(r'\b\d[\d,.]*(?:\s*[-–]\s*\d[\d,.]*)?\s*(?:hours?|hrs?)\b','',description,flags=re.I).strip(' ,;-')
        qualifier_only=fid in narrative and field_review['omittedFields'].get(fid) and all(':hours_qualifier_lost' in error for error in field_review['omittedFields'][fid])
        h=source_measurement(hours,checked['spans'][fid],pack) if fid not in narrative or qualifier_only else measurement('',quote)
        component=completed_component(hours,quote) if fid not in narrative else None
        source_only=fid in field_review.get('sourceOnlyActivityFields',[])
        flags=field_review.get('reviewFlags',[])
        unit_unestablished=any(flag.startswith(fid+':hours_unit_unestablished') for flag in flags)
        if unit_unestablished:h={'min':None,'max':None,'precision':'unreported'}
        activities.append({'category':category,'description':description or 'Reported activity','hours':h,'timing':'unknown' if source_only else 'source_snapshot' if component else 'projected' if timing=='planned' else 'unknown' if timing=='unknown' else 'source_snapshot','confidence':'mixed' if fid in narrative or unit_unestablished else 'source_supported','hoursMissingReason':'unresolved_measurement' if (fid in narrative and h['precision']=='unreported') or unit_unestablished or (hours and h['precision']=='unreported') else 'unreported' if not hours else None,'sourceField':fid,'sourcePostId':checked['spans'][fid]['postId'],'sourceAuthoredAt':next(post.get('authoredAt') for post in pack['posts'] if post['postId']==checked['spans'][fid]['postId'] and post['sourceArtifactSha256']==checked['spans'][fid]['sourceArtifactSha256'])})
    for i,row in enumerate(facts['outcomes']):
        fid=f'outcomes:{i}'
        if fid not in approved:continue
        status,program,school,outcome_cycle,count,_,quote=row
        count_unknown=any(flag.startswith(fid+':count_') for flag in checked.get('reviewFlags',[]))
        reported_count=int(count) if count and re.fullmatch('[1-9][0-9]*',count) and not count_unknown else None
        outcomes.append({'status':status,'program':program,'school':school or None,'cycle':outcome_cycle or 'unknown','reportedCount':reported_count,'countKind':'aggregate' if not school else 'school_observation','evidence':quote,'sourceUrl':checked['spans'][fid]['sourceUrl'],'conditional':False,'sourceField':fid})
    active_fields=set(fieldmap.values())|{a['sourceField'] for a in activities}|{o['sourceField'] for o in outcomes}|({'cycle'} if cycle!='unknown' else set())
    for field in sorted(active_fields):
        span=checked['spans'].get(field)
        if not span:raise ValueError('Approved normalized field missing an exact source span')
        evidence.append({'field':field,**{k:span[k] for k in ['postId','sourceUrl','sourceArtifactSha256','start','end','quote']}})
    if not (any(h['precision']!='unreported' for h in academic_measurements.values()) or activities or outcomes):return None
    source_urls=list(dict.fromkeys(s['sourceUrl'] for s in evidence))
    transcript={'version':1,'accountId':pack['accountKey'],'contentDigest':pack['contentDigest'],'scope':pack['scope'],'posts':pack['posts']}
    payload=(encode(transcript)+'\n').encode();digest=hashlib.sha256(payload).hexdigest();artifact_name=digest+'.json'
    artifact_dir.mkdir(mode=0o700,exist_ok=True,parents=True)
    path=artifact_dir/artifact_name
    if not path.exists():path.write_bytes(payload);path.chmod(0o600)
    elif hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise ValueError('Private transcript artifact corruption')
    authored=sorted(p['authoredAt'] for p in pack['posts'] if p['authoredAt'])
    observed=max(p['observedAt'] for p in pack['posts']);has_ar=any(o['status'] in ['accepted','rejected'] for o in outcomes)
    missing=[key for key in ['gpa','scienceGpa','mcat'] if academic_measurements[key]['precision']=='unreported']
    unavailable_numeric=[key for key in ['gpa','scienceGpa','mcat'] if academic_measurements[key]['precision']!='reported']
    if cycle=='unknown':missing.append('cycle')
    if not activities:missing.append('activities')
    if not has_ar:missing.append('acceptance_or_rejection')
    missing.append('application_time_activity_hours')
    notes=['Public self-report; reported facts do not establish a complete application or final cycle.','Activity quantities describe source-date snapshots; application-time alignment is not established.']
    if gate['blockedFields']:notes.append('Some numeric academics depend on quoted questions by another author; ambiguous metric identities remain unreported rather than reassigned.')
    if len({(a['category'],a['description']) for a in activities})<len(activities):notes.append('Repeated activity labels may represent updates or overlapping work; the separate source rows must not be added together.')
    if field_review.get('sourceOnlyActivityFields'):notes.append('Some reported roles were excluded or omitted from the application; they remain source-date narrative, not application totals.')
    if any(completed_component(row[2],row[-1]) for i,row in enumerate(facts['activities']) if f'activities:{i}' in approved):notes.append('Where explicitly labeled, activity hours use the completed/current component; anticipated quantities remain only in the source evidence.')
    if not has_ar:notes.append('No supported acceptance or rejection is reported in this normalized snapshot; this is not a rejection.')
    if field_review['omittedFields']:notes.append('Some fields or numeric measurements were omitted after evidence checks; omitted values remain unknown.')
    if any(a['hoursMissingReason']=='unresolved_measurement' for a in activities):notes.append('Some roles are supported while their hour quantities or units remain unresolved.')
    summary_parts=[]
    def academic_label(key,label):
        h=academic_measurements[key]
        if h['precision']=='reported':return label+' '+str(h['min']).removesuffix('.0')
        if h['precision']=='approximate':return label+' approximately '+str(h['min']).removesuffix('.0')
        if h['precision']=='range':return label+' range '+str(h['min'])+'–'+str(h['max'])
        if h['precision'] in ['lower_bound','upper_bound']:return label+' with a reported bound'
    if 'gpa' in selected:summary_parts.append(academic_label('gpa','GPA'))
    if 'mcat' in selected:summary_parts.append(academic_label('mcat','MCAT'))
    summary_parts=[part for part in summary_parts if part]
    summary=('Reported '+', '.join(summary_parts)+'. ') if summary_parts else ''
    summary+=('Activity evidence: '+', '.join(sorted({a['category'].replace('_',' ') for a in activities}))+'. ') if activities else 'Activities unreported or unresolved. '
    summary+='Acceptance/rejection evidence present.' if has_ar else 'Acceptance/rejection unreported.'
    exact=lambda key:academic_measurements[key]['min'] if academic_measurements[key]['precision']=='reported' else None
    public_handle=pack.get('publicHandle')
    if not public_handle and (artifact_dir.parent/'manifest.sqlite').exists():
        with sqlite3.connect(artifact_dir.parent/'manifest.sqlite') as db:
            r=db.execute('SELECT handle FROM frontier WHERE account_key=? AND handle IS NOT NULL AND handle!=\'\' ORDER BY key LIMIT 1',(pack['accountKey'],)).fetchone();public_handle=r[0] if r else None
    profile={'id':profile_id,'accountId':pack['accountKey'],'source':source,'sourceAccountId':source_id,'publicHandle':public_handle or source_id,'cycle':cycle,'gpa':exact('gpa'),'scienceGpa':exact('scienceGpa'),'mcat':int(exact('mcat')) if exact('mcat') is not None else None,'residence':selected.get('residence'),'summary':summary,'activities':activities,'outcomes':outcomes,'sourceUrls':source_urls,'observedAt':observed,'authoredAt':authored[0] if authored else None,'sourceSnapshotAt':authored[-1] if authored else None,'reviewStatus':'reviewed','extractionConfidence':'mixed','reviewedAt':field_review['reviewedAt'],'timingStatus':'retrospective_mixed' if outcomes else 'source_snapshot','notes':notes,'academics':{'basis':'Actual self-reported undergraduate GPA/MCAT where supported; values reflect source snapshots, not necessarily application-time values.'},'provenance':{'method':field_review['method'],'sourceContentSha256':digest,'sourceArtifactKey':'corpus/out11-2026-09-10/'+artifact_name,'auditInventory':'OUT-11 frozen public source inventory as of 2026-09-10T03:03:00Z'},'evidenceTier':'reviewed_outcome_report' if has_ar else 'reviewed_profile','reviewMethod':field_review['method'],'missingFields':missing,'unavailableNumericFields':unavailable_numeric,'academicMeasurements':academic_measurements,'humanReviewed':False,'evidenceSpans':evidence,'categoryHourTotals':{}}
    # Snapshot identity follows supported facts, not clock time or array order.
    identity={k:v for k,v in profile.items() if k not in {'id','reviewedAt','observedAt','provenance'}}
    snapshot=hashlib.sha256(encode(identity).encode()).hexdigest()
    profile['id']=profile_id+'-'+snapshot[:12]
    profile['version']=1  # First reviewed observation for every new OUT-11 account.
    return profile

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--state',default=str(Path(__file__).parent/'state'));parser.add_argument('--baseline',required=True);parser.add_argument('--output',default=str(Path(__file__).parent/'state'/'corpus-v2-candidate.json'));args=parser.parse_args()
    state=Path(args.state);baseline=json.loads(Path(args.baseline).read_text());context_store=SourceContextStore(state);baseline_ids={p['accountId'] for p in baseline['profiles']};new=[];errors=[]
    for path in sorted((state/'field-reviews').glob('*-'+PROCESS_VERSION+'.json')):
        record=json.loads(path.read_text())
        if record['accountKey'] in baseline_ids:continue
        try:
            profile=normalize(record,state/'private-transcripts',context_store)
            if profile:new.append(profile)
        except ValueError as error:errors.append({'accountKey':record['accountKey'],'error':str(error)})
    if len({p['accountId'] for p in new})!=len(new):raise ValueError('Multiple normalized revisions for one source account require explicit resolution')
    context_store.close()
    metadata=snapshot_metadata(state)
    for profile in new:
        profile['provenance']['auditInventory']='OUT-11 public source creation window '+metadata['creationScope'].get('startDate','unknown')+' through '+metadata['creationScope'].get('asOf','unknown')+'; actual capture dates are preserved per source.'
    data={**baseline,'version':2,**metadata,'profiles':baseline['profiles']+new,'preservedBaseline':{'release':baseline['release'],'profileCount':len(baseline['profiles']),'profilesSha256':hashlib.sha256(encode(baseline['profiles']).encode()).hexdigest()},'reviewMethodNote':'New records use machine extraction, deterministic exact-source validation, and independent model adjudication for outcomes, updates, conflicts or flags. They are not universally human reviewed.'}
    collection_manifest=state/'collection-provenance.json'
    if collection_manifest.exists():
        data['collectionManifestSha256']=hashlib.sha256(collection_manifest.read_bytes()).hexdigest()
        data['collectionReport']={'collection':json.loads((state/'checkpoint.json').read_text()),'annotation':json.loads((state/'annotation-checkpoint.json').read_text()),'creationScope':metadata['creationScope'],'captureObservationRange':metadata['captureObservationRange'],'recoveryRun':metadata['recoveryRun'],'newNormalizedAccounts':len(new),'normalizationErrors':len(errors)}
    atomic_text(Path(args.output),json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    report={'updatedAt':now(),'baselineAccountsPreserved':len(baseline_ids),'newNormalizedCandidateAccounts':len(new),'totalCandidateAccounts':len(data['profiles']),'newOutcomeReports':sum(p['evidenceTier']=='reviewed_outcome_report' for p in new),'newUnknownCycles':sum(p['cycle']=='unknown' for p in new),'errors':errors,'newImportedAccounts':0}
    atomic_text(state/'normalization-checkpoint.json',json.dumps(report,indent=2)+'\n');print(encode(report))

if __name__=='__main__':main()
