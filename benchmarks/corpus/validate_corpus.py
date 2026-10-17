#!/usr/bin/env python3
"""Independent source/byte/annotation checks; no inference, no network. MIT."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import csv,hashlib,json,re,subprocess,time
ROOT=Path(__file__).resolve().parent
def sha(data):return hashlib.sha256(data).hexdigest()
def main():
 manifest=json.loads((ROOT/'photo-manifest.json').read_text());cases=manifest['cases'];assert len(cases)==60
 assert Counter(c['split'] for c in cases)=={'dev':20,'heldout':40}
 assert len({c['imageId'] for c in cases})==60 and len({c['sha256'] for c in cases})==60
 assert len({c['authorGroup'] for c in cases})==60
 assert sha((ROOT/'source-manifest.json').read_bytes())==manifest['sourceManifestSha256']
 sources=json.loads((ROOT/'source-manifest.json').read_text())
 for item in sources:
  raw=(ROOT/item['path']).read_bytes();assert len(raw)==item['bytes'] and sha(raw)==item['sha256']
 with (ROOT/'source/boxes.csv').open(newline='') as file:boxes=list(csv.DictReader(file))
 with (ROOT/'source/labels.csv').open(newline='') as file:labels=list(csv.DictReader(file))
 owners=[];checks=[]
 for c in cases:
  raw=(ROOT/c['file']).read_bytes();assert len(raw)==c['bytes'] and sha(raw)==c['sha256']
  evidence_raw=(ROOT/c['license']['evidenceFile']).read_bytes();assert sha(evidence_raw)==c['license']['evidenceSha256'];e=json.loads(evidence_raw);obj=e['structuredData'];assert obj['@type']=='ImageObject' and obj['license']==c['license']['url']=='https://creativecommons.org/licenses/by/2.0/'
  assert obj['acquireLicensePage'].rstrip('/').split('/')[-1]==e['flickrPhotoId']==c['source']['originalLandingUrl'].rstrip('/').split('/')[-1]
  author=obj['author'];nsid=re.search(r'([0-9]+@N[0-9]+)',author.get('image',''));owners.append(nsid.group(1) if nsid else author['url'].rstrip('/'))
  if c['negativeEvidence']:
   row=labels[c['negativeEvidence']['sourceCsvRow']-2];assert row['ImageID']==c['imageId'] and row['LabelName']==c['targetClassId'] and row['Confidence']=='0' and row['Source']=='verification';assert c['targetBoxes']==[]
  else:
   actual=[b for b in boxes if b['ImageID']==c['imageId'] and b['LabelName']==c['targetClassId']];assert len(actual)==len(c['targetBoxes'])
   for b in c['targetBoxes']:
    row=boxes[b['sourceCsvRow']-2];assert row['ImageID']==c['imageId'] and row['LabelName']==c['targetClassId'];assert [float(row[k]) for k in ['XMin','YMin','XMax','YMax']]==b['xyxy'];assert int(row['IsDepiction'])==0 and int(row['IsGroupOf'])==0
   tag=c['primaryStratum'];bs=c['targetBoxes']
   if tag=='small':assert any(.0005<=(b['xyxy'][2]-b['xyxy'][0])*(b['xyxy'][3]-b['xyxy'][1])<=.01 for b in bs)
   if tag=='edge':assert any(b['truncated']==1 and min(b['xyxy'][0],b['xyxy'][1],1-b['xyxy'][2],1-b['xyxy'][3])<=.01 for b in bs)
   if tag=='occluded':assert any(b['occluded']==1 for b in bs)
   if tag=='duplicate':assert 2<=len(bs)<=8
  checks.append({'caseId':c['caseId'],'bytes':True,'licensePageIdentity':True,'sourceAnnotation':True})
 assert len(set(owners))==60
 for split,quotas in manifest['quotas'].items():
  assert Counter(c['primaryStratum'] for c in cases if c['split']==split)==quotas
  inputs=json.loads((ROOT/'inputs'/(split+'.json')).read_text());ground=json.loads((ROOT/'ground-truth'/(split+'.json')).read_text());assert len(inputs)==len(ground)==sum(quotas.values())
  for inp,gt in zip(inputs,ground):
   assert inp['caseId']==gt['caseId'];assert set(inp)=={'caseId','image','locate','classify'}
   assert not any(k in json.dumps(inp) for k in ['targetBoxes','negativeEvidence','expectedPresence','primaryStratum','sourceCsvRow'])
 version=subprocess.check_output(['/usr/bin/ffmpeg','-version'],text=True).splitlines()[0]
 def decode(c):
  start=time.monotonic();p=subprocess.run(['/usr/bin/ffmpeg','-v','error','-nostdin','-i',str(ROOT/c['file']),'-frames:v','1','-f','null','-'],capture_output=True,timeout=10,check=False)
  assert p.returncode==0,(c['caseId'],p.stderr.decode())
  return {'caseId':c['caseId'],'exitCode':p.returncode,'stderr':p.stderr.decode(),'durationMs':round((time.monotonic()-start)*1000,3)}
 with ThreadPoolExecutor(max_workers=4) as pool:decodes=list(pool.map(decode,cases))
 report={'version':1,'status':'passed','scope':'Structural source/GT/bytes/license evidence and actual JPEG decode; not model accuracy or independent human adjudication','photos':60,'splits':{'dev':20,'heldout':40},'uniqueCurrentAuthorIdentities':len(set(owners)),'classes':len({c['targetClassId'] for c in cases}),'photoBytes':sum(c['bytes'] for c in cases),'annotationChecks':checks,'jpegDecoder':version,'decodeChecks':decodes,'photoManifestSha256':sha((ROOT/'photo-manifest.json').read_bytes()),'sourceManifestSha256':sha((ROOT/'source-manifest.json').read_bytes()),'modelCalls':0}
 (ROOT/'validation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:report[k] for k in ['status','photos','splits','classes','photoBytes','uniqueCurrentAuthorIdentities','modelCalls']},indent=2))
if __name__=='__main__':main()
