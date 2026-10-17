#!/usr/bin/env python3
"""Fetch the frozen 60 photo IDs, without reselecting data or invoking a model. MIT."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib,json,urllib.request
ROOT=Path(__file__).resolve().parent

def fetch(case):
 image=case['imageId']
 if len(image)!=16 or any(c not in '0123456789abcdef' for c in image):raise ValueError('invalid image ID')
 expected='photos/'+image+'.jpg'
 if case['file']!=expected:raise ValueError('unexpected output path')
 path=ROOT/expected
 url='https://open-images-dataset.s3.amazonaws.com/validation/'+image+'.jpg'
 if case['source']['downloadUrl']!=url:raise ValueError('source not allowlisted')
 if path.exists():data=path.read_bytes()
 else:
  with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'ZoryaClassifierCorpus/1.0'}),timeout=30) as response:
   if response.url!=url:raise ValueError('unexpected redirect')
   data=response.read(5*1024*1024+1)
  if len(data)>5*1024*1024:raise ValueError('photo byte limit exceeded')
 if len(data)!=case['bytes'] or hashlib.sha256(data).hexdigest()!=case['sha256']:raise ValueError('canonical photo checksum mismatch: '+image)
 if not path.exists():
  path.parent.mkdir(exist_ok=True)
  with path.open('xb') as output:output.write(data)
 return image

if __name__=='__main__':
 manifest=json.loads((ROOT/'photo-manifest.json').read_text())
 if len(manifest['cases'])!=60:raise ValueError('expected frozen 60 photos')
 with ThreadPoolExecutor(max_workers=4) as pool:result=list(pool.map(fetch,manifest['cases']))
 print(json.dumps({'verifiedPhotos':len(result),'modelCalls':0}))
