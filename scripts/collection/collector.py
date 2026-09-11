#!/usr/bin/env python3
"""Resumable public student-corpus collection. Offline seed/status by default."""
from __future__ import annotations
import argparse, csv, hashlib, json, os, re, sqlite3, time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit, urljoin
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from urllib.robotparser import RobotFileParser
from parsers import classify_url, parse_html, VERSION, HOSTS

UA='OutpredictCorpusAudit/0.1 (+https://github.com/kingofsunnyvale/outpredict)'
MAX_BODY=4*1024*1024
SCHEMA='''
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discovery (url TEXT NOT NULL,account_key TEXT NOT NULL DEFAULT '',resource_key TEXT NOT NULL,discovered_from TEXT NOT NULL,metadata TEXT,PRIMARY KEY(url,account_key));
CREATE TABLE IF NOT EXISTS frontier (
 key TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, identity TEXT NOT NULL,
 page INTEGER NOT NULL, url TEXT NOT NULL, account_key TEXT, handle TEXT, metadata TEXT,
 discovered_from TEXT, discovered_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 priority INTEGER NOT NULL DEFAULT 10, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt REAL NOT NULL DEFAULT 0, lease_until REAL, last_error TEXT, current_hash TEXT,
 last_status INTEGER, fetched_at TEXT, etag TEXT, last_modified TEXT);
CREATE INDEX IF NOT EXISTS frontier_pending ON frontier(status,next_attempt,priority);
CREATE TABLE IF NOT EXISTS artifact (
 hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capture (
 id INTEGER PRIMARY KEY, key TEXT NOT NULL REFERENCES frontier(key), hash TEXT NOT NULL REFERENCES artifact(hash),
 observed_at TEXT NOT NULL, observation_basis TEXT NOT NULL, origin_path TEXT, http_status INTEGER,
 headers TEXT, UNIQUE(key,hash,observation_basis));
CREATE TABLE IF NOT EXISTS parse (
 key TEXT NOT NULL REFERENCES frontier(key), hash TEXT NOT NULL REFERENCES artifact(hash),
 version TEXT NOT NULL, parsed_at TEXT NOT NULL, json_path TEXT NOT NULL, status TEXT NOT NULL,
 error TEXT, PRIMARY KEY(key,hash,version));
CREATE TABLE IF NOT EXISTS post (
 source TEXT NOT NULL, post_id TEXT NOT NULL, hash TEXT NOT NULL, account_key TEXT NOT NULL,
 key TEXT NOT NULL, authored_at TEXT, text TEXT NOT NULL, source_url TEXT NOT NULL,
 images TEXT NOT NULL, PRIMARY KEY(source,post_id,hash));
CREATE INDEX IF NOT EXISTS post_accounts ON post(account_key);
CREATE TABLE IF NOT EXISTS attempt (
 id INTEGER PRIMARY KEY, key TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
 result TEXT, http_status INTEGER, error TEXT, retry_at REAL);
CREATE TABLE IF NOT EXISTS review (
 account_key TEXT NOT NULL, basis TEXT NOT NULL, decision TEXT NOT NULL, reviewed_at TEXT,
 notes TEXT, input_hashes TEXT NOT NULL, PRIMARY KEY(account_key,basis));
CREATE TABLE IF NOT EXISTS baseline_import (
 profile_id TEXT PRIMARY KEY, account_key TEXT NOT NULL, cycle TEXT NOT NULL, source TEXT NOT NULL,
 dataset_hash TEXT NOT NULL, evidence TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS host_state (
 host TEXT PRIMARY KEY, next_request REAL NOT NULL DEFAULT 0, blocked_until REAL NOT NULL DEFAULT 0,
 block_reason TEXT, robots_body TEXT, robots_status INTEGER, robots_checked REAL,
 robots_interval REAL NOT NULL DEFAULT 3);
'''

def now():return datetime.now(timezone.utc).isoformat(timespec='seconds')
def encode(obj):return json.dumps(obj,ensure_ascii=False,sort_keys=True)
def atomic_text(path,text):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_text(text);os.chmod(tmp,0o600);tmp.replace(path)

class Store:
    def close(self):
        if getattr(self,'db',None) is not None:
            self.db.close();self.db=None
    def __del__(self):
        try:self.close()
        except Exception:pass
    def __init__(self, directory):
        self.root=Path(directory);self.root.mkdir(parents=True,exist_ok=True);os.chmod(self.root,0o700)
        self.db=sqlite3.connect(self.root/'manifest.sqlite',timeout=30);self.db.row_factory=sqlite3.Row
        self.db.executescript(SCHEMA);self.db.execute('PRAGMA journal_mode=WAL');self.db.commit()
        os.chmod(self.root/'manifest.sqlite',0o600)
        if 'in_scope' not in [r[1] for r in self.db.execute('PRAGMA table_info(frontier)')]:
            self.db.execute('ALTER TABLE frontier ADD COLUMN in_scope INTEGER NOT NULL DEFAULT 1');self.db.commit()
    def enqueue(self,url,discovered_from,account=None,handle=None,metadata=None,priority=10):
        r=classify_url(url)
        self.db.execute('''INSERT INTO frontier (key,source,kind,identity,page,url,account_key,handle,metadata,discovered_from,discovered_at,priority)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
            account_key=COALESCE(frontier.account_key,excluded.account_key),handle=COALESCE(frontier.handle,excluded.handle),
            metadata=COALESCE(frontier.metadata,excluded.metadata),priority=MIN(frontier.priority,excluded.priority)''',
            (r['key'],r['source'],r['kind'],r['identity'],r['page'],url,account,handle,encode(metadata) if metadata else None,discovered_from,now(),priority))
        self.db.execute('INSERT OR IGNORE INTO discovery VALUES(?,?,?,?,?)',(url,account or '',r['key'],discovered_from,encode(metadata) if metadata else None))
        scope=self.db.execute("SELECT value FROM config WHERE key='scope'").fetchone()
        if scope and r['source']=='sdn' and r['kind']=='thread' and metadata:
            scope=json.loads(scope[0]);date=(metadata.get('authoredAt') or metadata.get('date') or '')[:10]
            if date and (date<scope['startDate'] or date>scope['asOf'][:10]):
                self.db.execute("UPDATE frontier SET in_scope=0,status=CASE WHEN current_hash IS NULL THEN 'excluded_scope' ELSE status END,last_error='Thread creation outside frozen collection scope; later updates require relevance review' WHERE key=?",(r['key'],))
        self.db.commit();return r['key']
    def row(self,key):return self.db.execute('SELECT * FROM frontier WHERE key=?',(key,)).fetchone()
    def capture(self,key,body,observed_at,basis,origin=None,status=None,headers=None):
        digest=hashlib.sha256(body).hexdigest();rel=Path('artifacts')/digest[:2]/(digest+'.html');path=self.root/rel
        if not path.exists():
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body);os.chmod(path,0o600)
        elif hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise ValueError('Stored artifact digest mismatch')
        self.db.execute('INSERT OR IGNORE INTO artifact VALUES(?,?,?,?)',(digest,len(body),str(rel),now()))
        self.db.execute('INSERT OR IGNORE INTO capture(key,hash,observed_at,observation_basis,origin_path,http_status,headers) VALUES(?,?,?,?,?,?,?)',
            (key,digest,observed_at,basis,origin,status,encode(headers or {})))
        previous=self.row(key)
        # Re-seeding cached audit material must not replace a newer live revision.
        if not previous['fetched_at'] or observed_at>=previous['fetched_at']:
            self.db.execute("UPDATE frontier SET current_hash=?,status='fetched',fetched_at=?,last_status=?,lease_until=NULL,last_error=NULL WHERE key=?",(digest,observed_at,status,key))
        self.db.commit()
        return digest
    def parse(self,key,force=False):
        r=self.row(key);digest=r['current_hash']
        if not digest:raise ValueError('Cannot parse missing capture')
        old=self.db.execute('SELECT status FROM parse WHERE key=? AND hash=? AND version=?',(key,digest,VERSION)).fetchone()
        if old and old['status']=='parsed' and not force:return
        a=self.db.execute('SELECT path FROM artifact WHERE hash=?',(digest,)).fetchone()
        body=(self.root/a['path']).read_bytes()
        if hashlib.sha256(body).hexdigest()!=digest:raise ValueError('Artifact corruption')
        rel=Path('parsed')/digest[:2]/(hashlib.sha256((key+digest+VERSION).encode()).hexdigest()+'.json')
        try:
            result=parse_html(body.decode('utf-8',errors='replace'),r['url'],r['account_key'],r['handle'])
            atomic_text(self.root/rel,encode(result)+'\n')
            self.db.execute('INSERT OR REPLACE INTO parse VALUES(?,?,?,?,?,?,?)',(key,digest,VERSION,now(),str(rel),'parsed',None))
            self.db.execute("UPDATE frontier SET status='parsed',lease_until=NULL,last_error=NULL WHERE key=?",(key,))
            for p in result['posts']:
                self.db.execute('INSERT OR REPLACE INTO post VALUES(?,?,?,?,?,?,?,?,?)',
                  (r['source'],p['postId'],digest,p['accountKey'],key,p['authoredAt'],p['text'],p['sourceUrl'],encode(p['images'])))
            self.db.commit()
            for child in result['records']:
                # Metadata is not a profile. Sticky instruction threads aren't applicant records.
                priority=5 if re.search(r'result|outcome|reapp|accept|reject',child.get('title',''),re.I) else 10
                if re.search(r'important.*format.*wamc|read.*before.*post',child.get('title',''),re.I):priority=90
                self.enqueue(child['url'],r['url'],child.get('accountKey'),child.get('publicHandle'),child,priority)
            scope=self.db.execute("SELECT value FROM config WHERE key='scope'").fetchone()
            next_urls=result['next']
            if scope and r['source']=='sdn' and r['kind']=='index':
                scope=json.loads(scope[0]);dates=[x.get('authoredAt','')[:10] for x in result['records'] if x.get('authoredAt')]
                if dates and max(dates)<scope['startDate']:next_urls=[]
            for url in next_urls:
                self.enqueue(url,r['url'],r['account_key'] if r['kind']=='thread' else None,r['handle'] if r['kind']=='thread' else None,priority=r['priority'])
        except (ValueError,PermissionError) as error:
            state='blocked' if isinstance(error,PermissionError) else 'parse_failed'
            self.db.execute('INSERT OR REPLACE INTO parse VALUES(?,?,?,?,?,?,?)',(key,digest,VERSION,now(),str(rel),state,str(error)))
            self.db.execute('UPDATE frontier SET status=?,last_error=?,lease_until=NULL WHERE key=?',(state,str(error),key));self.db.commit()
    def claim(self,source=None):
        t=time.time();self.db.execute('BEGIN IMMEDIATE')
        self.db.execute("UPDATE frontier SET status='retry',lease_until=NULL,last_error='Interrupted fetch lease expired' WHERE status='fetching' AND lease_until<?",(t,))
        sql="SELECT * FROM frontier WHERE status IN ('queued','retry') AND next_attempt<=? AND attempts<6";args=[t]
        if source:sql+=' AND source=?';args.append(source)
        sql+=' ORDER BY priority,source,CASE kind WHEN \'profile\' THEN 0 WHEN \'thread\' THEN 1 ELSE 2 END,account_key,key LIMIT 1'
        r=self.db.execute(sql,args).fetchone()
        if r:self.db.execute("UPDATE frontier SET status='fetching',attempts=attempts+1,lease_until=? WHERE key=?",(t+120,r['key']))
        self.db.commit();return self.row(r['key']) if r else None
    def status(self):
        def one(sql,*p):return self.db.execute(sql,p).fetchone()[0]
        sources={}
        for source in ('sdn','mdapplicants','reddit'):
            states={r[0]:r[1] for r in self.db.execute('SELECT status,COUNT(*) FROM frontier WHERE source=? GROUP BY status',(source,))}
            sources[source]={'frontier':states,'capturedResources':one('SELECT COUNT(DISTINCT c.key) FROM capture c JOIN frontier f ON f.key=c.key WHERE f.source=?',source),
             'capturedProfileResources':one("SELECT COUNT(DISTINCT c.key) FROM capture c JOIN frontier f ON f.key=c.key WHERE f.source=? AND f.kind!='index'",source),
             'parsedAccounts':one('SELECT COUNT(DISTINCT account_key) FROM post WHERE source=?',source),
             'parsedAccountsInCreationScope':one('SELECT COUNT(DISTINCT p.account_key) FROM post p JOIN frontier f ON f.key=p.key WHERE p.source=? AND f.in_scope=1',source),
             'originalPostIds':one('SELECT COUNT(DISTINCT post_id) FROM post WHERE source=?',source),
             'scheduledAttempts':one('SELECT COUNT(*) FROM attempt a JOIN frontier f ON f.key=a.key WHERE f.source=?',source),
             'pageHttpResponses':one('SELECT COUNT(*) FROM attempt a JOIN frontier f ON f.key=a.key WHERE f.source=? AND a.http_status IS NOT NULL',source),
             'blockedBeforePageRequest':one("SELECT COUNT(*) FROM attempt a JOIN frontier f ON f.key=a.key WHERE f.source=? AND a.http_status IS NULL AND a.result='blocked'",source)}
        return {'updatedAt':now(),'sources':sources,
          'reviewsByDecision':{r[0]:r[1] for r in self.db.execute('SELECT decision,COUNT(DISTINCT account_key) FROM review GROUP BY decision')},
          'baselineImportedAccounts':one('SELECT COUNT(DISTINCT account_key) FROM baseline_import'),
          'newImportedAccounts':0,'qualificationRule':'No parser result is automatically qualified or imported.',
          'hostBlocks':[dict(r) for r in self.db.execute('SELECT host,blocked_until,block_reason FROM host_state WHERE blocked_until>?',(time.time(),))]}
    def report(self):
        stats=self.status();atomic_text(self.root/'checkpoint.json',json.dumps(stats,indent=2)+'\n');return stats


def seed_audit(store,audit,baseline):
    audit=Path(audit)
    if not (audit/'sdn_recent_index.json').is_file():raise ValueError('Expected original reviewed audit directory')
    index=json.loads((audit/'sdn_recent_index.json').read_text())
    byid={re.search(r'(\d+)(?:/|$)',r['url'].rstrip('/')+'/')[1]:r for r in index}
    for r in index:
        uid=r['user_id'];account='sdn:'+(uid if uid not in ('','0') else 'deleted-handle:'+r['user'].lower())
        store.enqueue(r['url'],'legacy:sdn_recent_index.json',account,r['user'],r)
    for f in sorted(audit.glob('sdn_index_*.html')):
        page=int(re.search(r'(\d+)',f.name)[1]);url=f'https://forums.studentdoctor.net/forums/what-are-my-chances-wamc-medical.418/page-{page}?order=post_date&direction=desc'
        key=store.enqueue(url,'legacy:'+f.name,priority=20)
        store.capture(key,f.read_bytes(),'2026-09-07','legacy_audit_date_not_http_timestamp',str(f));store.parse(key)
    for f in sorted(audit.glob('sdn_thread_*.html')):
        ident=re.search(r'(\d+)',f.name)[1];r=byid.get(ident)
        if not r:continue
        key=classify_url(r['url'])['key'];store.capture(key,f.read_bytes(),'2026-09-07','legacy_audit_date_not_http_timestamp',str(f));store.parse(key)
    for f in sorted(audit.glob('mdapp_[0-9]*.html')):
        ident=re.search(r'(\d+)',f.name)[1];url='https://www.mdapplicants.com/profile/'+ident
        key=store.enqueue(url,'legacy:'+f.name,'mdapplicants:'+ident,priority=10)
        store.capture(key,f.read_bytes(),'2026-09-07','legacy_audit_date_not_http_timestamp',str(f));store.parse(key)
    # Start from public dated search and follow only observed links, never enumerate guessed profile IDs.
    store.enqueue('https://www.mdapplicants.com/search_result.php?search_app_date=2023-05-01','legacy:README.md',priority=20)
    for r in csv.DictReader((audit/'reddit_verified.csv').open()):
        store.enqueue(r['url'],'legacy:reddit_verified.csv','reddit:'+r['public_handle'].lower(),r['public_handle'],r,priority=2 if r['source_type']=='standalone' else 15)
    for r in csv.DictReader((audit/'sdn_sample_classification.csv').open()):
        account='sdn:'+r['account_id'];hashes=[x[0] for x in store.db.execute('SELECT DISTINCT hash FROM post WHERE account_key=?',(account,))]
        store.db.execute('INSERT OR REPLACE INTO review VALUES(?,?,?,?,?,?)',(account,'2026-09-07 single-reviewer sample', 'legacy_qualifying' if r['qualifies']=='True' else 'legacy_not_established','2026-09-07',r['interpretation'],encode(hashes)))
    for r in csv.DictReader((audit/'mdapp_classification.csv').open()):
        account='mdapplicants:'+r['profile_id'];hashes=[x[0] for x in store.db.execute('SELECT DISTINCT hash FROM post WHERE account_key=?',(account,))]
        decision='legacy_qualifying' if r['qualifies']=='True' else 'legacy_borderline' if r['activity_completeness']=='borderline' else 'legacy_out_of_window' if r['in_window']=='False' else 'legacy_not_established'
        store.db.execute('INSERT OR REPLACE INTO review VALUES(?,?,?,?,?,?)',(account,'2026-09-07 single-reviewer profile audit',decision,'2026-09-07',encode(r),encode(hashes)))
    if baseline:
        data=Path(baseline).read_bytes();digest=hashlib.sha256(data).hexdigest()
        for p in json.loads(data)['profiles']:
            store.db.execute('INSERT OR IGNORE INTO baseline_import VALUES(?,?,?,?,?,?)',(p['id'],p['accountId'],p['cycle'],p['source'],digest,encode({'reviewedAt':p['reviewedAt'],'sourceUrls':p['sourceUrls'],'provenance':p['provenance']})))
    store.db.commit();return store.report()


def retry_after(value,t=None):
    t=time.time() if t is None else t
    if not value:return None
    try:return t+max(0,int(value))
    except ValueError:
        try:return max(t,parsedate_to_datetime(value).timestamp())
        except (ValueError,TypeError,OverflowError):return None

class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        old=urlsplit(req.full_url);new=urlsplit(newurl)
        if new.hostname != old.hostname or new.scheme!='https':raise PermissionError('Cross-host/non-HTTPS redirect blocked')
        if new.path!='/robots.txt':classify_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

class Fetcher:
    def __init__(self,store,allow_network=False,interval=3):
        self.store=store;self.allow_network=allow_network;self.interval=max(1,float(interval));self.opener=build_opener(SafeRedirect())
    def request(self,url,headers=None):
        if not self.allow_network:raise PermissionError('Network is disabled; use explicit --allow-network after authorization')
        u=urlsplit(url)
        if u.hostname not in HOSTS or u.scheme!='https':raise PermissionError('Unapproved source')
        request=Request(url,headers={'User-Agent':UA,'Accept':'text/html,text/plain;q=0.9','Accept-Encoding':'identity',**(headers or {})})
        started=time.monotonic()
        try:response=self.opener.open(request,timeout=25)
        except HTTPError as error:response=error
        with response:
            code=response.status;result_headers={k.lower():v for k,v in response.headers.items() if k.lower() in ('content-type','content-length','etag','last-modified','retry-after','location')}
            if int(result_headers.get('content-length','0'))>MAX_BODY:raise ValueError('Response exceeds byte limit')
            chunks=[];size=0
            while True:
                if time.monotonic()-started>35:raise TimeoutError('Response exceeded total deadline')
                chunk=response.read(min(65536,MAX_BODY-size+1))
                if not chunk:break
                size+=len(chunk)
                if size>MAX_BODY:raise ValueError('Response exceeds byte limit')
                chunks.append(chunk)
            return code,result_headers,b''.join(chunks)
    def host_wait(self,host):
        db=self.store.db;db.execute('INSERT OR IGNORE INTO host_state(host) VALUES(?)',(host,));db.commit()
        db.execute('BEGIN IMMEDIATE');r=db.execute('SELECT * FROM host_state WHERE host=?',(host,)).fetchone();t=time.time()
        if r['blocked_until']>t:db.commit();return r['blocked_until']
        when=max(t,r['next_request']);interval=max(self.interval,r['robots_interval'])
        if when-t>50:db.commit();return when
        db.execute('UPDATE host_state SET next_request=? WHERE host=?',(when+interval,host));db.commit()
        if when>t:time.sleep(when-t)
        return None
    def robots(self,url):
        host=urlsplit(url).hostname;db=self.store.db
        db.execute('INSERT OR IGNORE INTO host_state(host) VALUES(?)',(host,));db.commit()
        r=db.execute('SELECT * FROM host_state WHERE host=?',(host,)).fetchone();t=time.time()
        if r['blocked_until']>t:raise PermissionError(r['block_reason'] or 'Host unavailable')
        if not r['robots_checked'] or t-r['robots_checked']>86400:
            wait=self.host_wait(host)
            if wait:raise PermissionError('Host retry window not reached')
            code,headers,body=self.request('https://'+host+'/robots.txt')
            if code in (401,403,429) or code>=500:
                until=retry_after(headers.get('retry-after'),t) or t+3600
                db.execute('UPDATE host_state SET blocked_until=?,block_reason=? WHERE host=?',(until,'robots HTTP '+str(code),host));db.commit();raise PermissionError('Robots unavailable; collection paused')
            if code not in (200,404,410):raise PermissionError('Robots status not verified')
            txt=body.decode('utf-8',errors='replace') if code==200 else ''
            if '<html' in txt.lower():raise PermissionError('Robots returned HTML, not verified policy')
            parser=RobotFileParser();parser.parse(txt.splitlines());delay=parser.crawl_delay(UA) or 0;rate=parser.request_rate(UA)
            interval=max(delay,rate.seconds/rate.requests if rate and rate.requests else 0)
            db.execute('UPDATE host_state SET robots_body=?,robots_status=?,robots_checked=?,robots_interval=? WHERE host=?',(txt,code,t,interval,host));db.commit()
        else:txt=r['robots_body'] or ''
        parser=RobotFileParser();parser.parse(txt.splitlines())
        if not parser.can_fetch(UA,url):raise PermissionError('robots.txt disallows this URL')
    def fetch_one(self,row):
        key=row['key'];url=row['url'];host=urlsplit(url).hostname;db=self.store.db
        attempt=db.execute('INSERT INTO attempt(key,started_at) VALUES(?,?)',(key,now())).lastrowid;db.commit()
        state='retry';error=None;code=None;retry=time.time();t=time.time()
        try:
            self.robots(url);wait=self.host_wait(host)
            if wait:state='retry';retry=wait;error='Host rate/backoff window';return
            headers={}
            if row['etag']:headers['If-None-Match']=row['etag']
            if row['last_modified']:headers['If-Modified-Since']=row['last_modified']
            code,returned,body=self.request(url,headers)
            if code==304 and row['current_hash']:state='parsed';return
            if code in (401,403):
                state='blocked';error='Public source requires access or denied request'
                db.execute('UPDATE host_state SET blocked_until=?,block_reason=? WHERE host=?',(t+86400,'HTTP '+str(code),host));return
            if code==429 or code>=500:
                retry=retry_after(returned.get('retry-after'),t) or t+min(3600,30*2**row['attempts'])
                error='Transient HTTP '+str(code)
                db.execute('UPDATE host_state SET blocked_until=?,block_reason=? WHERE host=?',(retry,error,host));return
            if code in (404,410):state='gone';error='Public source missing';return
            if code!=200:state='blocked';error='Unexpected HTTP '+str(code);return
            ctype=returned.get('content-type','').lower()
            if 'html' not in ctype and 'text/plain' not in ctype:state='parse_failed';error='Unexpected content type';return
            self.store.capture(key,body,now(),'network_retrieval',status=code,headers=returned)
            db.execute('UPDATE frontier SET etag=?,last_modified=? WHERE key=?',(returned.get('etag'),returned.get('last-modified'),key));db.commit()
            self.store.parse(key);state=self.store.row(key)['status'];error=self.store.row(key)['last_error']
            if state=='blocked':db.execute('UPDATE host_state SET blocked_until=?,block_reason=? WHERE host=?',(t+86400,error,host))
        except PermissionError as exc:state='blocked';error=str(exc)
        except (ValueError,URLError,TimeoutError,OSError) as exc:
            error=type(exc).__name__+': '+str(exc)[:250];retry=t+min(3600,30*2**row['attempts'])
            if row['attempts']>=6:state='exhausted'
        finally:
            if state=='retry' and row['attempts']>=6:state='exhausted'
            db.execute('UPDATE frontier SET status=?,last_error=?,last_status=?,next_attempt=?,lease_until=NULL WHERE key=?',(state,error,code,retry,key))
            db.execute('UPDATE attempt SET completed_at=?,result=?,http_status=?,error=?,retry_at=? WHERE id=?',(now(),state,code,error,retry,attempt));db.commit()
    def run(self,batch,source=None):
        if not self.allow_network:raise PermissionError('Network disabled')
        completed=0
        while completed<batch:
            row=self.store.claim(source)
            if not row:break
            self.fetch_one(row);completed+=1
            if completed%10==0:print(encode({'checkpointAttempts':completed,**self.store.report()}),flush=True)
            # Don't burn the frontier into failed states after one host block.
            blocked=self.store.db.execute('SELECT blocked_until FROM host_state WHERE host=?',(urlsplit(row['url']).hostname,)).fetchone()
            if blocked and blocked[0]>time.time():break
        return {'checkpointAttempts':completed,**self.store.report()}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--state',default=str(Path(__file__).parent/'state'))
    sub=parser.add_subparsers(dest='command',required=True)
    s=sub.add_parser('seed');s.add_argument('--audit',required=True);s.add_argument('--baseline');s.add_argument('--start-date',default='2023-05-01');s.add_argument('--as-of',default=None)
    sub.add_parser('status')
    p=sub.add_parser('parse');p.add_argument('--force',action='store_true')
    f=sub.add_parser('fetch');f.add_argument('--allow-network',action='store_true');f.add_argument('--batch',type=int,default=50);f.add_argument('--source',choices=['sdn','mdapplicants','reddit']);f.add_argument('--interval',type=float,default=3);f.add_argument('--until-idle',action='store_true')
    args=parser.parse_args();store=Store(args.state)
    if args.command=='seed':
        store.db.execute('INSERT OR IGNORE INTO config VALUES(?,?)',('scope',encode({'startDate':args.start_date,'asOf':args.as_of or now(),'includeCurrentProfiles':True})));store.db.commit()
        result=seed_audit(store,args.audit,args.baseline)
    elif args.command=='status':result=store.report()
    elif args.command=='parse':
        for row in list(store.db.execute("SELECT key FROM frontier WHERE current_hash IS NOT NULL")):store.parse(row['key'],args.force)
        result=store.report()
    else:
        if args.batch<1:parser.error('batch must be positive; this is a checkpoint size, not a corpus cap')
        fetcher=Fetcher(store,args.allow_network,args.interval)
        while True:
            result=fetcher.run(args.batch,args.source)
            if not args.until_idle or not result['checkpointAttempts'] or result['hostBlocks']:break
            print(encode(result),flush=True)
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
