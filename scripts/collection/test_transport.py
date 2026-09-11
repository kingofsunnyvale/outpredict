import unittest
from urllib.request import Request
from urllib.error import HTTPError
from annotate import NoRedirectHandler

class TransportTests(unittest.TestCase):
 def test_authorized_annotation_request_never_follows_redirect(self):
  handler=NoRedirectHandler();request=Request('https://api.openai.com/v1/chat/completions',headers={'Authorization':'Bearer synthetic-test-only'})
  for target in ['https://other.invalid/receive','http://api.openai.com/path','https://api.openai.com/new']:
   with self.assertRaises(HTTPError):handler.redirect_request(request,None,307,'redirect',{},target)
if __name__=='__main__':unittest.main()
