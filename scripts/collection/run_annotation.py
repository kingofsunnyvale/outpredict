"""Resumable cost-metered extraction/review checkpoints, never direct product import."""
import argparse,concurrent.futures,hashlib,json,re,time,copy
from pathlib import Path
from annotate import annotate,PROMPT_VERSION
from semantic_review import review,VERSION as REVIEW_VERSION
from validation import validate
from budget import Budget,BudgetExceeded,ApiBackoff
from collector import Store,atomic_text,encode,now
from review import pack_accounts

PROCESS_VERSION='out11-field-review-3'

def prepare_extraction(extraction,pack,path):
    value=copy.deepcopy(extraction);repairs=[]
    for section,width in [('academics',4),('activities',6),('outcomes',7)]:
        for i,row in enumerate(value['facts'][section]):
            if len(row)!=width:continue
            if re.fullmatch(r'[1-9]\d*',row[-1]) and int(row[-1])<=len(pack['posts']) and row[-2] in pack['posts'][int(row[-1])-1]['text'] and not re.fullmatch(r'[1-9]\d*',row[-2]):
                row[-2],row[-1]=row[-1],row[-2];repairs.append({'field':f'{section}:{i}','kind':'exact_witness_index_quote_swap'})
    # Repair schema cells only when an exact quote identifies one occurrence in
    # one original-author post. No values, roles or timing are inferred.
    for section,width in [('academics',4),('activities',6),('outcomes',7)]:
        for i,row in enumerate(value['facts'][section]):
            if len(row)!=width:continue
            valid_index=bool(re.fullmatch(r'[1-9]\d*',row[-2]) and int(row[-2])<=len(pack['posts']) and row[-1] in pack['posts'][int(row[-2])-1]['text'])
            if valid_index:continue
            candidates=[]
            for cell in [-1,-2]:
                quote=row[cell]
                if len(quote)<8:continue
                matches=[j+1 for j,post in enumerate(pack['posts']) if post['text'].count(quote)==1]
                total=sum(post['text'].count(quote) for post in pack['posts'])
                if len(matches)==1 and total==1:candidates.append((quote,matches[0]))
            if len(candidates)==1:
                original=[row[-2],row[-1]];row[-2]=str(candidates[0][1]);row[-1]=candidates[0][0]
                repairs.append({'field':f'{section}:{i}','kind':'unique_exact_source_quote_witness_recovered','originalCells':original})
    check=validate(value['facts'],pack)
    for i,row in enumerate(value['facts']['outcomes']):
        if len(row)==7 and any(flag.startswith(f'outcomes:{i}:count_') for flag in check.get('reviewFlags',[])):
            repairs.append({'field':f'outcomes:{i}','kind':'unestablished_count_omitted','originalValue':row[4]});row[4]=''
    for i,row in enumerate(value['facts']['activities']):
        if len(row)==6 and row[2] and (not re.search(r'\d',row[2]) or (re.search(r'\byears?|months?|semesters?|weeks?|days?\b',row[2],re.I) and not re.search(r'\bhours?|hrs?\b',row[2],re.I))):
            repairs.append({'field':f'activities:{i}','kind':'nonhour_quantity_omitted','originalValue':row[2]});row[2]=''
    if repairs:
        value['repairLog']=repairs;target=path.with_name(path.stem+'-repaired.json');atomic_text(target,json.dumps(value,ensure_ascii=False,indent=2)+'\n');return value,target
    return value,path

def process(row,state,credentials,cached_only=False,force=False):
    pack_path=state/row['path'];pack=json.loads(pack_path.read_text());name=pack_path.stem
    outdir=state/'annotations';outdir.mkdir(mode=0o700,exist_ok=True)
    reviews=state/'semantic-reviews';reviews.mkdir(mode=0o700,exist_ok=True)
    processed=state/'field-reviews';processed.mkdir(mode=0o700,exist_ok=True)
    target=processed/(name+'-'+PROCESS_VERSION+'.json')
    if target.exists() and not force:return json.loads(target.read_text())
    if all(not re.search(r'\w',p['text']) or re.fullmatch(r'\[?(?:deleted|removed)\]?[.!\s]*',p['text'].strip(),re.I) for p in pack['posts']):
        result={'accountKey':pack['accountKey'],'contentDigest':pack['contentDigest'],'packPath':str(pack_path),'reviewedAt':now(),'processVersion':PROCESS_VERSION,'reviewStatus':'excluded_source_no_content','method':'deterministic_empty_or_deleted_placeholder_check','supportedFields':[],'omittedFields':{},'humanReviewed':False,'reason':'Every original-author body contains only punctuation/whitespace or an exact deleted/removed placeholder.'}
        atomic_text(target,json.dumps(result,indent=2)+'\n');return result
    b=Budget(state/'api-budget.sqlite')
    try:
        path=outdir/(name+'-'+PROMPT_VERSION+'.json')
        if cached_only and not path.exists():raise ValueError('No cached extraction; offline revalidation never calls API')
        extraction=json.loads(path.read_text()) if path.exists() else annotate(pack_path,outdir,credentials,budget=b)
        extraction,path=prepare_extraction(extraction,pack,path)
        overrides_path=state/'source-review-overrides.json';overrides=[]
        if overrides_path.exists():
            overrides=[r for r in json.loads(overrides_path.read_text()) if r['accountKey']==pack['accountKey'] and r['contentDigest']==pack['contentDigest']]
        for override in overrides:
            repair=override.get('repair',{})
            if repair=={'program':'unspecified_medical'} and re.fullmatch(r'outcomes:\d+',override['fieldID']):
                index=int(override['fieldID'].split(':')[1]);row=extraction['facts']['outcomes'][index]
                post=pack['posts'][int(row[-2])-1]
                if row[-1]!=override['sourceQuote'] or post['postId']!=override['sourcePostId'] or post['sourceArtifactSha256']!=override['sourceArtifactSha256']:raise ValueError('Source-audit repair witness mismatch')
                extraction=copy.deepcopy(extraction);extraction['facts']['outcomes'][index][1]='unspecified_medical'
                extraction.setdefault('repairLog',[]).append({'field':override['fieldID'],'kind':'source_audit_unestablished_program_omitted','originalValue':row[1]})
                path=outdir/(name+'-'+PROMPT_VERSION+'-repaired.json');atomic_text(path,json.dumps(extraction,ensure_ascii=False,indent=2)+'\n')
        facts=extraction['facts'];check=validate(facts,pack)
        fields={f'{section}:{i}':row for section in ['academics','activities','outcomes'] for i,row in enumerate(facts[section])}
        if facts['cycle']:fields['cycle']=[facts['cycle'],facts['cycleEvidence']]
        need_review=bool(facts['outcomes'] or len(pack['posts'])>1 or check['errors'] or check.get('reviewFlags') or re.search(r'conflict|contradict|multiple actual|uncertain',encode(facts.get('notes',[])),re.I))
        adjudication=None
        if need_review and fields:
            review_path=reviews/(pack['accountKey'].replace(':','_')+'-'+pack['contentDigest'][:12]+'-'+REVIEW_VERSION+'.json')
            # Revision4 compacts only response encoding; reuse valid revision3
            # source adjudications rather than paying for the same semantic task.
            legacy_review=reviews/(pack['accountKey'].replace(':','_')+'-'+pack['contentDigest'][:12]+'-out11-semantic-3.json')
            if not review_path.exists() and legacy_review.exists():review_path=legacy_review
            if cached_only and not review_path.exists():raise ValueError('No cached independent review; offline revalidation never calls API')
            adjudication=json.loads(review_path.read_text()) if review_path.exists() else review(extraction,pack,reviews,credentials,b)
            if adjudication['errors']:raise ValueError('Independent semantic review did not cover all fields')
        rejected={}
        for error in check['errors']:
            m=re.match(r'((?:academics|activities|outcomes):\d+|cycle)(?::|$)',error)
            if m:rejected.setdefault(m[1],[]).append(error)
            else:
                for field in fields:rejected.setdefault(field,[]).append(error)
        if adjudication:
            for field,d in adjudication['decisions'].items():
                if not d['supported']:rejected.setdefault(field,[]).append('semantic: '+d['reason'])
        overrides_path=state/'source-review-overrides.json';overrides=[]
        if overrides_path.exists():
            overrides=[r for r in json.loads(overrides_path.read_text()) if r['accountKey']==pack['accountKey'] and r['contentDigest']==pack['contentDigest']]
        for override in overrides:
            field=override['fieldID']
            if field not in fields:continue
            hard=[error for error in check['errors'] if error.startswith(field+':')]
            if (override['decision']=='supported' or override.get('repair')=={'program':'unspecified_medical'}) and not hard:rejected.pop(field,None)
            elif override['decision']=='unsupported':rejected.setdefault(field,[]).append('source_audit: '+override['reason'])
        supported=[field for field in fields if field not in rejected]
        narrative=[]
        for field,errors in rejected.items():
            if field.startswith('activities:') and adjudication and adjudication['decisions'].get(field,{}).get('supported') and all(':hours_' in error or ':unparsed_hours' in error for error in errors):
                narrative.append(field)
        for override in overrides:
            if override['decision']=='narrative_only' and override['fieldID'].startswith('activities:') and override['fieldID'] in fields:
                narrative.append(override['fieldID'])
        source_only=[]
        for field,errors in rejected.items():
            if not field.startswith('activities:') or not adjudication:continue
            decision=adjudication['decisions'].get(field,{})
            reason=decision.get('reason','')
            index=int(field.split(':')[1]);row=facts['activities'][index]
            if decision.get('supported') is False and re.search(r'(?:not|removed|excluded|forgot|forgotten).*?(?:AMCAS|primary|application)|(?:AMCAS|primary|application).*?(?:not included|removed|excluded|forgot)',reason,re.I) and re.search(r'not.*(?:list|include)|removed|forgot|excluded',row[-1],re.I):
                hard=[error for error in check['errors'] if error.startswith(field+':') and ':hours_' not in error and ':unparsed_hours' not in error]
                if not hard:
                    narrative.append(field);source_only.append(field)
        result={'accountKey':pack['accountKey'],'contentDigest':pack['contentDigest'],'packPath':str(pack_path),'extractionPath':str(path),'reviewedAt':now(),'processVersion':PROCESS_VERSION,'method':'independent_model_review_and_exact_source_validation' if adjudication else 'model_extraction_and_exact_source_validation','supportedFields':supported,'narrativeOnlyFields':list(set(narrative)),'sourceOnlyActivityFields':source_only,'omittedFields':rejected,'sourceAuditOverrides':overrides,'repairLog':extraction.get('repairLog',[]),'timingGuard':check['timingGuard'],'reviewFlags':check.get('reviewFlags',[]),'semanticNotes':adjudication['notes'] if adjudication else [],'reviewStatus':'field_reviewed_candidate' if supported or narrative else 'excluded_no_supported_fields','humanReviewed':False}
        atomic_text(target,json.dumps(result,ensure_ascii=False,indent=2)+'\n');return result
    except BudgetExceeded:raise
    except ApiBackoff:
        return {'accountKey':pack['accountKey'],'reviewStatus':'deferred_provider_backoff'}
    except Exception as error:
        result={'accountKey':pack['accountKey'],'contentDigest':pack['contentDigest'],'reviewedAt':now(),'processVersion':PROCESS_VERSION,'reviewStatus':'needs_review','error':type(error).__name__+': '+str(error)[:180]}
        atomic_text(target,json.dumps(result,indent=2)+'\n');return result

def ready_queue(state):
    s=Store(state);pack_accounts(s)
    pending={r[0] for r in s.db.execute("SELECT DISTINCT account_key FROM frontier WHERE in_scope=1 AND status IN ('queued','fetching','retry','fetched') AND account_key IS NOT NULL")}
    rows=[json.loads(line) for line in (state/'review-queue.jsonl').read_text().splitlines()]
    return [r for r in rows if r['inCreationScope'] and not r['baselineImported'] and r['accountKey'] not in pending],s

def checkpoint(state):
    results=[json.loads(p.read_text()) for p in (state/'field-reviews').glob('*-'+PROCESS_VERSION+'.json')]
    statuses={status:sum(r['reviewStatus']==status for r in results) for status in sorted({r['reviewStatus'] for r in results})}
    report={'updatedAt':now(),'fieldReviewCounts':statuses,'supportedFields':sum(len(r.get('supportedFields',[])) for r in results),'omittedFields':sum(len(r.get('omittedFields',{})) for r in results),'budget':Budget(state/'api-budget.sqlite').status(),'newImportedAccounts':0,'note':'Reviewed candidates still require normalized release validation and staged import; these counts are not live product counts.'}
    atomic_text(state/'annotation-checkpoint.json',json.dumps(report,indent=2)+'\n');print(encode(report),flush=True);return report

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--state',default=str(Path(__file__).parent/'state'));parser.add_argument('--credentials',required=True);parser.add_argument('--allow-api',action='store_true');parser.add_argument('--workers',type=int,default=4);parser.add_argument('--checkpoint-size',type=int,default=20);parser.add_argument('--until-idle',action='store_true');args=parser.parse_args()
    if not args.allow_api:raise SystemExit('API disabled; --allow-api required')
    if not 1<=args.workers<=16 or args.checkpoint_size<1:raise SystemExit('Use 1–16 API workers and a positive checkpoint size')
    state=Path(args.state);(state/'field-reviews').mkdir(exist_ok=True,mode=0o700)
    b=Budget(state/'api-budget.sqlite');b.seed_pilots(state/'annotations')
    while True:
        rows,s=ready_queue(state)
        todo=[r for r in rows if not (state/'field-reviews'/((state/r['path']).stem+'-'+PROCESS_VERSION+'.json')).exists()]
        if not todo:
            checkpoint(state)
            pending=s.db.execute("SELECT COUNT(*) FROM frontier WHERE source='sdn' AND status IN ('queued','fetching','retry','fetched')").fetchone()[0]
            if not args.until_idle or not pending:break
            time.sleep(20);continue
        try:
            deferred=False
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
                futures=[pool.submit(process,row,state,Path(args.credentials)) for row in todo[:args.checkpoint_size]]
                for future in concurrent.futures.as_completed(futures):
                    r=future.result();deferred=deferred or r['reviewStatus']=='deferred_provider_backoff';print(encode({'accountKey':r['accountKey'],'status':r['reviewStatus'],'supported':len(r.get('supportedFields',[])),'omitted':len(r.get('omittedFields',{}))}),flush=True)
        except BudgetExceeded:
            checkpoint(state);print('Annotation cost guard reached; no new requests scheduled. Public collection is independent.',flush=True);break
        checkpoint(state)
        if not args.until_idle:break
        if deferred:time.sleep(20)

if __name__=='__main__':main()
