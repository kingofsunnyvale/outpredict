"""Source parsers: public student material only; extraction is not qualification."""
from __future__ import annotations
from dataclasses import dataclass, field
from html.parser import HTMLParser
import re
from urllib.parse import urljoin, urlsplit, parse_qs, urlencode

VERSION = 'out11-parser-3'
HOSTS = {'forums.studentdoctor.net': 'sdn', 'www.mdapplicants.com': 'mdapplicants',
         'www.reddit.com': 'reddit'}
VOID = set('area base br col embed hr img input link meta param source track wbr'.split())

@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)
    def has(self, cls): return cls in self.attrs.get('class', '').split()
    def findall(self, predicate, skip=()):
        out = []
        for c in self.children:
            if isinstance(c, Node):
                if c.tag in skip: continue
                if predicate(c): out.append(c)
                out.extend(c.findall(predicate,skip))
        return out
    def first(self, predicate):
        return next(iter(self.findall(predicate)), None)
    def text(self, skip=('script', 'style', 'blockquote')):
        if self.tag in skip: return ''
        chunks = [c.text(skip) if isinstance(c, Node) else c for c in self.children]
        return re.sub(r'\s+', ' ', ' '.join(chunks)).strip()

class Tree(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node('root'); self.stack = [self.root]; self.feed(html)
    def handle_starttag(self, tag, attrs):
        # The MDApplicants HTML has unclosed li tags; preserve HTML list semantics.
        if tag in ('li', 'tr', 'td', 'th', 'p'):
            boundaries = {'li': ('ul','ol'), 'tr': ('table',), 'td': ('tr',), 'th': ('tr',), 'p': ('div','section')}[tag]
            for i in range(len(self.stack)-1, 0, -1):
                if self.stack[i].tag == tag: self.stack = self.stack[:i]; break
                if self.stack[i].tag in boundaries: break
        node = Node(tag, dict(attrs)); self.stack[-1].children.append(node)
        if tag not in VOID: self.stack.append(node)
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID: self.handle_endtag(tag)
    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1, 0, -1):
            if self.stack[i].tag == tag: self.stack = self.stack[:i]; break
    def handle_data(self, data): self.stack[-1].children.append(data)


def classify_url(url):
    u=urlsplit(url)
    if u.scheme != 'https' or u.hostname not in HOSTS or u.username or u.password or u.port not in (None,443):
        raise ValueError('URL is not an allowed public source')
    source=HOSTS[u.hostname]; path=u.path
    if source == 'sdn':
        m=re.fullmatch(r'/threads/(?:[^/]*\.)?(\d+)/(?:page-(\d+))?/?', path)
        if m:
            ident,page=m[1],int(m[2] or 1)
            return dict(key=f'sdn:thread:{ident}:{page}',source=source,kind='thread',identity=ident,page=page,url=url)
        m=re.fullmatch(r'/forums/[^/]*\.(\d+)/(?:page-(\d+))?/?',path)
        if m:
            ident,page=m[1],int(m[2] or 1)
            return dict(key=f'sdn:index:{ident}:{page}',source=source,kind='index',identity=ident,page=page,url=url)
    if source == 'mdapplicants':
        m=re.fullmatch(r'/profile/(\d+)/?',path)
        if m: return dict(key=f'mdapplicants:profile:{m[1]}:1',source=source,kind='profile',identity=m[1],page=1,url=url)
        if path in ('/search_result.php','/search_more.php'):
            # Query identity keeps distinct public date/search scopes separate.
            q=urlencode(sorted((k,v) for k,vs in parse_qs(u.query).items() for v in vs))
            return dict(key=f'mdapplicants:index:{q}',source=source,kind='index',identity=q,page=1,url=url)
    if source == 'reddit':
        m=re.match(r'/r/([A-Za-z0-9_]+)/comments/([a-z0-9]+)(?:/|$)',path)
        if m: return dict(key=f'reddit:thread:{m[2]}:1',source=source,kind='thread',identity=m[2],page=1,url=url)
    raise ValueError('URL path is not a supported public source resource')


def next_links(tree, url, info):
    links=[]
    for a in tree.findall(lambda n:n.tag in ('a','link') and ('next' in n.attrs.get('rel','').split() or n.has('pageNav-jump--next'))):
        nxt=urljoin(url,a.attrs.get('href',''))
        try: c=classify_url(nxt)
        except ValueError: continue
        if c['source']==info['source'] and c['kind']==info['kind'] and c['identity']==info['identity'] and c['page']>info['page']:
            links.append(nxt)
    return list(dict.fromkeys(links))


def candidates(text):
    """Search aids, never normalized facts or an automatic acceptance decision."""
    patterns={
      'gpa':r'(?:[cs]?GPA|overall GPA)\s*[:=]?\s*[0-4]\.\d+',
      'mcat':r'(?:MCAT|total MCAT score)\s*[:=]?\s*(?:4[7-9]\d|5[0-2]\d)',
      'outcome':r'accept\w*|reject\w*|admitt\w*|waitlist\w*|\b\d+\s*(?:MD|DO)?\s*[AR]\b',
      'activity':r'clinical|research|shadow|volunteer|teaching|tutor|leadership|publication|scribe| EMT\b',
      'timing':r'projected|planned|anticipat\w*|expected|will have|reapplicant|last cycle|previous cycle',
    }
    out={}
    for key,pat in patterns.items():
        matches=list(re.finditer(pat,text,re.I))
        out[key]={'mentionCount':len(matches),'excerpts':[text[max(0,m.start()-60):m.end()+100] for m in matches[:12]]}
    return out


def parse_sdn_index(tree,url,info):
    rows=[]
    for n in tree.findall(lambda n:n.has('structItem--thread')):
        title=n.first(lambda n:n.has('structItem-title'))
        a=title.first(lambda n:n.tag=='a' and '/threads/' in n.attrs.get('href','')) if title else None
        tm=n.first(lambda n:n.tag=='time')
        who=n.first(lambda n:n.tag=='a' and n.has('username'))
        if not a or not tm: continue
        link=urljoin(url,a.attrs['href'])
        try: row=classify_url(link)
        except ValueError: continue
        uid=who.attrs.get('data-user-id','') if who else ''
        handle=who.text() if who else n.attrs.get('data-author','')
        row.update(title=title.text(),authoredAt=tm.attrs.get('datetime'),publicHandle=handle,
                   accountKey='sdn:'+ (uid if uid not in ('','0') else 'deleted-handle:'+handle.lower()),
                   identityBasis='numeric_source_id' if uid not in ('','0') else 'legacy_deleted_handle')
        rows.append(row)
    if not rows: raise ValueError('No SDN thread index structure; not a successful parsed listing')
    return dict(records=rows,posts=[],next=next_links(tree,url,info),candidates={})


def parse_sdn_thread(tree,url,info,account_key=None,handle=None):
    if info['page']>1 and not account_key:
        raise ValueError('Later thread pages require an established original-poster identity')
    posts=[]; root_author=None; root_account=None
    articles=tree.findall(lambda n:n.tag=='article' and n.has('message--post'))
    for a in articles:
        body=a.first(lambda n:n.has('bbWrapper'))
        if not body: continue
        user=a.first(lambda n:n.tag=='a' and n.has('username'))
        uid=user.attrs.get('data-user-id','') if user else ''
        author=a.attrs.get('data-author','')
        key='sdn:'+(uid if uid not in ('','0') else 'deleted-handle:'+author.lower())
        if root_author is None: root_author,root_account=author,key
        # Prefer a known numeric source identity, then explicit author-handle fallback.
        expected=account_key or root_account
        owned=(key==expected) if not expected.startswith('sdn:deleted-handle:') else author.lower()==(handle or root_author or '').lower()
        if not owned: continue
        tm=a.first(lambda n:n.tag=='time')
        text=body.text(); post_id=a.attrs.get('data-content',a.attrs.get('id',''))
        posts.append(dict(postId=post_id,accountKey=expected,publicHandle=author,
                          authoredAt=tm.attrs.get('datetime') if tm else None,text=text,
                          sourceUrl=url.split('#')[0]+'#'+post_id,
                          images=[urljoin(url,i.attrs.get('src','')) for i in body.findall(lambda n:n.tag=='img',skip=('blockquote',)) if i.attrs.get('src')],
                          excludedQuotedBlocks=len(body.findall(lambda n:n.tag=='blockquote'))))
    # A later page can contain only replies. Still follow its public pagination;
    # never assign the first reply author as the applicant or lose later updates.
    if not posts and not (info['page']>1 and account_key and articles):
        raise ValueError('No original-poster content; identity or page structure requires review')
    combined='\n\n'.join(p['text'] for p in posts)
    return dict(records=[],posts=posts,next=next_links(tree,url,info),candidates=candidates(combined))


def parse_md_profile(tree,url,info):
    section=tree.first(lambda n:n.has('profile-page')); sub=tree.first(lambda n:n.attrs.get('id')=='subcontent')
    if not section or not sub: raise ValueError('No public MDApplicants profile structure')
    header=section.first(lambda n:n.attrs.get('id')=='profileheader')
    name=header.first(lambda n:n.tag=='h2') if header else None
    # Only application material. Excludes demographics/header, site navigation and modal controls.
    cycles=sub.findall(lambda n:n.tag=='div' and re.fullmatch(r'appcycle_\d+_box',n.attrs.get('id','')))
    if not cycles: raise ValueError('No application cycle structure')
    posts=[]; outcomes=[]
    for cycle in cycles:
        h=cycle.first(lambda n:n.tag=='h3'); cycle_label=h.text() if h else None
        for box in cycle.findall(lambda n:n.has('results-box')):
            school=box.first(lambda n:n.has('results-trigger'))
            flags={}
            for li in box.findall(lambda n:n.tag=='li'):
                span=li.first(lambda n:n.tag=='span')
                if not span: continue
                label=span.text().strip().rstrip(':?').lower(); whole=li.text()
                flags[label]=whole[len(span.text()):].strip()
            explicit=[s for key,s in [('accepted','accepted'),('rejected','rejected'),('waitlisted','waitlisted'),('interview attended','interview')] if flags.get(key,'').lower()=='yes']
            outcomes.append(dict(school=school.text() if school else None,cycleLabel=cycle_label,reportedFlags=flags,
                                 statuses=explicit or ['unknown'],sourceUrl=url+'#'+box.attrs.get('id','')))
        text=cycle.text()
        posts.append(dict(postId=cycle.attrs['id'],accountKey='mdapplicants:'+info['identity'],publicHandle=name.text() if name else info['identity'],
                          authoredAt=None,cycleLabel=cycle_label,text=text,sourceUrl=url,images=[],excludedQuotedBlocks=0))
    combined='\n\n'.join(p['text'] for p in posts)
    return dict(records=[],posts=posts,next=[],candidates=candidates(combined),schoolObservations=outcomes)


def parse_md_index(tree,url,info):
    records=[]
    for a in tree.findall(lambda n:n.tag=='a' and re.match(r'^/?profile/\d+',n.attrs.get('href',''))):
        link=urljoin(url,a.attrs['href'])
        try:r=classify_url(link)
        except ValueError:continue
        if r['kind']!='profile':continue
        r.update(accountKey='mdapplicants:'+r['identity'],publicHandle=a.text());records.append(r)
    if not records:
        if urlsplit(url).path=='/search_more.php' and not tree.text():
            return dict(records=[],posts=[],next=[],candidates={},endOfListing=True)
        raise ValueError('No public MDApplicants profile links')
    # Replicate the site's observed public Show More operation (table_utils.js).
    # Do not follow school/undergraduate filters into a combinatorial search crawl.
    nxt=[];more=tree.first(lambda n:n.tag=='input' and n.attrs.get('id')=='get_more_url')
    if more:
        base=urljoin(url,more.attrs['value']);q=parse_qs(urlsplit(base).query)
        current=tree.first(lambda n:n.attrs.get('id')=='from_api')
        page=int(current.attrs.get('value','0') if current else 0)+1
    elif urlsplit(url).path=='/search_more.php':
        base=url;q=parse_qs(urlsplit(url).query);page=int(q.get('psr',['0'])[0])+1
    else:base=None
    if base:
        q.update(psr=[str(page)],orderby=['AMCASDateSortField'],order=['desc'])
        nxt=[urljoin(base,urlsplit(base).path)+'?'+urlencode(q,doseq=True)]
    return dict(records=list({r['key']:r for r in records}.values()),posts=[],next=nxt,candidates={},paginationBasis='Observed public Show More endpoint and audited table_utils.js')



def parse_html(html,url,account_key=None,handle=None):
    info=classify_url(url);tree=Tree(html).root
    title=tree.first(lambda n:n.tag=='title'); title=title.text() if title else ''
    if re.search(r'just a moment|access denied|security check|verify you are human|robot challenge',title,re.I):
        raise PermissionError('Access/challenge page; no bypass attempted')
    if info['source']=='sdn' and info['kind']=='index':out=parse_sdn_index(tree,url,info)
    elif info['source']=='sdn':out=parse_sdn_thread(tree,url,info,account_key,handle)
    elif info['source']=='mdapplicants' and info['kind']=='profile':out=parse_md_profile(tree,url,info)
    elif info['source']=='mdapplicants':out=parse_md_index(tree,url,info)
    else:raise ValueError('Reddit content requires a separately verified accessible public parser; retain capture without treating it as parsed')
    return dict(parserVersion=VERSION,resource=info,title=title,**out)
