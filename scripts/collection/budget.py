"""Atomic local API spend guard. Does not claim to read the account balance."""
import json, sqlite3, time
from pathlib import Path

def cost(usage):
    details=usage.get('prompt_tokens_details',{})
    prompt=usage.get('prompt_tokens',0);cached=details.get('cached_tokens',0);writes=details.get('cache_write_tokens',0)
    return ((prompt-cached)*4+cached*.4+writes+usage.get('completion_tokens',0)*20)/1e6

class BudgetExceeded(RuntimeError):pass
class ApiBackoff(RuntimeError):pass

class Budget:
    def close(self):
        if getattr(self,'db',None) is not None:
            self.db.close();self.db=None
    def __del__(self):
        try:self.close()
        except Exception:pass
    def __init__(self,path,limit=85):
        self.path=Path(path);self.path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.db=sqlite3.connect(path,timeout=30);self.db.row_factory=sqlite3.Row
        self.db.executescript('''CREATE TABLE IF NOT EXISTS budget_config (id INTEGER PRIMARY KEY CHECK(id=1),limit_usd REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS api_usage (id TEXT PRIMARY KEY,phase TEXT NOT NULL,status TEXT NOT NULL,reserved_usd REAL NOT NULL,charged_usd REAL,started_at REAL NOT NULL,completed_at REAL,usage_json TEXT,error TEXT);''')
        self.db.execute('INSERT OR IGNORE INTO budget_config VALUES(1,?)',(limit,));self.db.commit();self.path.chmod(0o600)
        self.db.execute('CREATE TABLE IF NOT EXISTS api_pause (id INTEGER PRIMARY KEY CHECK(id=1),until_ts REAL NOT NULL,reason TEXT NOT NULL)');self.db.commit()
    def seed_pilots(self,directory):
        for p in Path(directory).glob('*.json'):
            record=json.loads(p.read_text())
            if 'usage' not in record:continue
            if not all(k in record for k in ['accountKey','contentDigest','promptVersion']):continue
            key=record['accountKey']+':'+record['contentDigest']+':'+record['promptVersion']
            self.db.execute('INSERT OR IGNORE INTO api_usage VALUES(?,?,?,?,?,?,?,?,?)',(key,'pilot','complete',0,cost(record['usage']),time.time(),time.time(),json.dumps(record['usage']),None))
        self.db.commit()
    def status(self):
        row=self.db.execute('SELECT COALESCE(SUM(COALESCE(charged_usd,reserved_usd)),0) AS committed,COALESCE(SUM(charged_usd),0) AS spent,COUNT(*) AS attempts FROM api_usage').fetchone()
        limit=self.db.execute('SELECT limit_usd FROM budget_config').fetchone()[0]
        return {'limitUsd':limit,'committedUsd':round(row['committed'],6),'measuredSpendUsd':round(row['spent'],6),'remainingUnreservedUsd':round(limit-row['committed'],6),'attempts':row['attempts']}
    def reserve(self,key,phase,request_bytes,max_output):
        # The byte bound deliberately overestimates input tokenization; the
        # reservation is replaced by measured token cost after a known response.
        upper=(request_bytes*1.2*5+max_output*20)/1e6
        self.db.execute('BEGIN IMMEDIATE')
        pause=self.db.execute('SELECT until_ts FROM api_pause WHERE id=1').fetchone()
        if pause and pause[0]>time.time():
            self.db.rollback();raise ApiBackoff('Provider Retry-After window is active; no request sent')
        if self.db.execute('SELECT 1 FROM api_usage WHERE id=?',(key,)).fetchone():
            self.db.commit();raise RuntimeError('Attempt already reserved; do not retry an uncertain API call blindly')
        s=self.status()
        if s['remainingUnreservedUsd']<upper:
            self.db.rollback();raise BudgetExceeded('Local annotation spend guard reached; collection continues independently')
        self.db.execute('INSERT INTO api_usage VALUES(?,?,?,?,?,?,?,?,?)',(key,phase,'reserved',upper,None,time.time(),None,None,None));self.db.commit()
    def pause(self,until,reason):
        self.db.execute('INSERT INTO api_pause VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET until_ts=MAX(api_pause.until_ts,excluded.until_ts),reason=excluded.reason',(until,reason));self.db.commit()
    def finish(self,key,usage,error=None):
        self.db.execute('UPDATE api_usage SET status=?,charged_usd=?,completed_at=?,usage_json=?,error=? WHERE id=?',('complete' if not error else 'failed_response',cost(usage),time.time(),json.dumps(usage),error,key));self.db.commit()
    def uncertain(self,key,error):
        # Keep the full reservation when an interrupted response gives no usage.
        self.db.execute("UPDATE api_usage SET status='uncertain',completed_at=?,error=? WHERE id=?",(time.time(),str(error)[:180],key));self.db.commit()
