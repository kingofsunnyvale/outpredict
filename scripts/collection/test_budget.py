import json,tempfile,unittest
from pathlib import Path
from budget import Budget,BudgetExceeded,ApiBackoff,cost
import time

class BudgetTests(unittest.TestCase):
    def test_usage_includes_cache_write_premium(self):
        self.assertAlmostEqual(cost({'prompt_tokens':1000,'completion_tokens':100,'prompt_tokens_details':{'cache_write_tokens':800,'cached_tokens':100}}),.00644)
    def test_reserved_cost_survives_uncertain_failure(self):
        with tempfile.TemporaryDirectory() as d:
            b=Budget(Path(d)/'budget.sqlite',.1);b.reserve('one','extract',1000,1000)
            committed=b.status()['committedUsd'];b.uncertain('one','timeout')
            self.assertEqual(b.status()['committedUsd'],committed)
            with self.assertRaises(RuntimeError):b.reserve('one','extract',1000,1000)
    def test_atomic_ceiling_and_actual_refund(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'budget.sqlite';a=Budget(p,.03);b=Budget(p,100)
            a.reserve('one','extract',1000,1000)
            with self.assertRaises(BudgetExceeded):b.reserve('two','extract',1000,1000)
            a.finish('one',{'prompt_tokens':100,'completion_tokens':100})
            b.reserve('two','extract',1000,1000)
            self.assertLessEqual(b.status()['committedUsd'],.03)
    def test_pilot_seeding_is_same_identity_as_api_attempt(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);(p/'pilot.json').write_text(json.dumps({'accountKey':'sdn:1','contentDigest':'abc','promptVersion':'v2','usage':{'prompt_tokens':100,'completion_tokens':100}}))
            b=Budget(p/'budget.sqlite');b.seed_pilots(p);b.seed_pilots(p)
            self.assertEqual(b.status()['attempts'],1)
            with self.assertRaises(RuntimeError):b.reserve('sdn:1:abc:v2','extract',1000,1000)
    def test_provider_pause_prevents_new_reservations(self):
        with tempfile.TemporaryDirectory() as d:
            b=Budget(Path(d)/'budget.sqlite');b.pause(time.time()+60,'HTTP429')
            with self.assertRaises(ApiBackoff):b.reserve('one','extract',1000,1000)
            self.assertEqual(b.status()['attempts'],0)

if __name__=='__main__':unittest.main()
