from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib,json,time,urllib.request
ROOT=Path(__file__).resolve().parent
SOURCES={
'images.csv':'https://storage.googleapis.com/openimages/2018_04/validation/validation-images-with-rotation.csv',
'boxes.csv':'https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv',
'labels.csv':'https://storage.googleapis.com/openimages/v5/validation-annotations-human-imagelabels-boxable.csv',
'classes.csv':'https://storage.googleapis.com/openimages/v7/oidv7-class-descriptions-boxable.csv',
'openimages-readme.md':'https://raw.githubusercontent.com/openimages/dataset/main/README.md',
'cvdf-readme.md':'https://raw.githubusercontent.com/cvdfoundation/open-images-dataset/master/README.md',
'openimages-license-readme.md':'https://raw.githubusercontent.com/openimages/dataset/main/READMEV3.md'}
def fetch(item):
 name,url=item;p=ROOT/'source'/name
 if p.exists():
  data=p.read_bytes()
  return {'path':str(p.relative_to(ROOT)),'sourceUrl':url,'retrievedAtUnix':p.stat().st_mtime,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'cache':'existing-local-exact-fetch'}
 req=urllib.request.Request(url,headers={'User-Agent':'ZoryaClassifierCorpus/1.0 (dataset provenance preparation)'})
 started=time.time()
 with urllib.request.urlopen(req,timeout=45) as response:
  data=response.read(64*1024*1024+1)
  if len(data)>64*1024*1024:raise ValueError('source cap')
  final=response.url
 p.write_bytes(data)
 return {'path':str(p.relative_to(ROOT)),'sourceUrl':url,'resolvedUrl':final,'retrievedAtUnix':started,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
if __name__=='__main__':
 with ThreadPoolExecutor(max_workers=4) as pool:records=list(pool.map(fetch,SOURCES.items()))
 (ROOT/'source-manifest.json').write_text(json.dumps(records,indent=2)+'\n')
 print(json.dumps(records,indent=2))
