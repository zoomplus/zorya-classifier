#!/usr/bin/env python3
"""Build a fixed, source-attributed diagnostic corpus; never invokes a model.
Code license: MIT. Photo/annotation licenses remain separate.
"""
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import csv,datetime,hashlib,json,re,urllib.request
ROOT=Path(__file__).resolve().parent
SEED='zorya-classifier-corpus-v1-2026-10-18'
PHOTO_LICENSE='https://creativecommons.org/licenses/by/2.0/'
CLASSES={'Person','Dog','Cat','Bicycle','Car','Chair','Bottle','Coffee cup','Book','Backpack','Bus','Traffic light','Boat','Bird','Horse','Train','Motorcycle','Flower','Vase','Mobile phone','Laptop','Clock','Suitcase','Bench','Stop sign','Rabbit','Spoon','Camera','Handbag','Ball','Plate','Table','Knife','Tree','Airplane','Truck','Couch','Sunglasses','Hat','Helmet','Umbrella','Bowl','Fork','Teddy bear','Orange','Apple','Banana','Fish','Butterfly','Mug'}
QUOTAS={'dev':{'baseline':4,'negative':4,'small':3,'edge':3,'occluded':3,'duplicate':3},'heldout':{'baseline':6,'negative':6,'small':7,'edge':7,'occluded':7,'duplicate':7}}
UA='ZoryaClassifierCorpus/1.0 (public benchmark source attribution)'
def sha(data):return hashlib.sha256(data).hexdigest()
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def read_csv(name):
 with (ROOT/'source'/name).open(newline='') as file:return list(csv.DictReader(file))
def request(url,limit):
 req=urllib.request.Request(url,headers={'User-Agent':UA})
 with urllib.request.urlopen(req,timeout=25) as response:
  data=response.read(limit+1)
  if len(data)>limit:raise ValueError('response exceeds bound')
  return data,response.url,response.status

def jpeg_dimensions(data):
 if not data.startswith(b'\xff\xd8'):raise ValueError('not JPEG')
 i=2
 while i<len(data):
  if data[i]!=255:raise ValueError('bad JPEG marker')
  while i<len(data) and data[i]==255:i+=1
  marker=data[i];i+=1
  if marker in [0xd8,0xd9] or 0xd0<=marker<=0xd7:continue
  n=int.from_bytes(data[i:i+2],'big')
  if n<2 or i+n>len(data):raise ValueError('truncated JPEG')
  if marker in [0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]:
   h=int.from_bytes(data[i+3:i+5],'big');w=int.from_bytes(data[i+5:i+7],'big')
   if not 32<=w<=4096 or not 32<=h<=4096 or w*h>16_000_000:raise ValueError('pixel bound')
   return w,h
  i+=n
 raise ValueError('JPEG dimensions absent')

def license_evidence(meta):
 path=ROOT/'licenses'/(meta['ImageID']+'.json')
 if path.exists():return json.loads(path.read_text())
 data,final,status=request(meta['OriginalLandingURL'],2*1024*1024)
 # Only page-specific structured ImageObject data qualifies: the global list of
 # available license choices in Flickr JavaScript is deliberately not evidence.
 matches=[]
 for raw in re.findall(r'<script[^>]*type=[\"\']application/ld\+json[\"\'][^>]*>(.*?)</script>',data.decode('utf-8'),re.S|re.I):
  obj=json.loads(raw)
  items=obj.get('@graph',[obj]) if isinstance(obj,dict) else obj
  for item in items:
   if isinstance(item,dict) and item.get('@type')=='ImageObject':matches.append((item,raw))
 photo_id=meta['OriginalLandingURL'].rstrip('/').split('/')[-1]
 admitted=[(item,raw) for item,raw in matches if item.get('acquireLicensePage','').rstrip('/').split('/')[-1]==photo_id and item.get('license')==PHOTO_LICENSE]
 if len(admitted)!=1:raise ValueError('page-specific CC BY2.0 license not verified')
 item,raw=admitted[0]
 evidence={'sourceUrl':meta['OriginalLandingURL'],'resolvedUrl':final,'httpStatus':status,'checkedAt':now(),'sourcePageBytes':len(data),'sourcePageSha256':sha(data),'extraction':'ImageObject matching the original Flickr photo ID; not global license strings','structuredData':item,'structuredBlockSha256':sha(raw.encode()),'verifiedLicenseUrl':PHOTO_LICENSE,'flickrPhotoId':photo_id,'rawPagePersisted':False}
 path.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');return evidence

def get_photo(candidate,metadata):
 image=candidate['imageId'];meta=metadata[image]
 evidence=license_evidence(meta)
 url='https://open-images-dataset.s3.amazonaws.com/validation/'+image+'.jpg'
 path=ROOT/'photos'/(image+'.jpg')
 if path.exists():data=path.read_bytes();resolved=url
 else:
  data,resolved,status=request(url,5*1024*1024);path.write_bytes(data)
 width,height=jpeg_dimensions(data)
 return {**candidate,'file':str(path.relative_to(ROOT)),'sha256':sha(data),'bytes':len(data),'width':width,'height':height,'source':{'dataset':'Open Images validation (V7 download index, V5 validation boxes/labels)','imageId':image,'originalSplit':'validation','downloadUrl':url,'resolvedDownloadUrl':resolved,'originalUrl':meta['OriginalURL'],'originalLandingUrl':meta['OriginalLandingURL'],'originalMD5Base64':meta['OriginalMD5'],'originalSize':meta['OriginalSize'],'rotationMetadata':meta['Rotation'],'retrievedAt':now(),'transformation':'CVDF upstream aspect-preserving max-side1024 resize; no local resize/crop/normalization'},'license':{'spdx':'CC-BY-2.0','url':PHOTO_LICENSE,'title':meta['Title'],'author':meta['Author'],'authorUrl':meta['AuthorProfileURL'],'currentAuthor':evidence['structuredData'].get('author'),'evidenceFile':str((ROOT/'licenses'/(image+'.json')).relative_to(ROOT)),'evidenceSha256':sha((ROOT/'licenses'/(image+'.json')).read_bytes()),'verification':'original-photo-page ImageObject license independently checked; no ownership warranty'},'authorGroup':meta['AuthorProfileURL'].rstrip('/')}

def prepare():
 for name in ['photos','licenses','inputs','ground-truth']: (ROOT/name).mkdir(exist_ok=True)
 metadata={r['ImageID']:r for r in read_csv('images.csv') if r['License']==PHOTO_LICENSE and r['Rotation'] in ('','0','0.0')}
 classes={r['LabelName']:r['DisplayName'] for r in read_csv('classes.csv')}
 wanted={mid for mid,title in classes.items() if title in CLASSES}
 boxes_by_image=defaultdict(list);target_boxes=defaultdict(list)
 for index,row in enumerate(read_csv('boxes.csv'),start=2):
  image=row['ImageID'];mid=row['LabelName']
  if image not in metadata:continue
  box={'classId':mid,'className':classes.get(mid,mid),'xyxy':[float(row[k]) for k in ['XMin','YMin','XMax','YMax']],'source':row['Source'],'sourceCsvRow':index,'occluded':int(row['IsOccluded']),'truncated':int(row['IsTruncated']),'groupOf':int(row['IsGroupOf']),'depiction':int(row['IsDepiction']),'inside':int(row['IsInside'])}
  x0,y0,x1,y1=box['xyxy'];assert 0<=x0<x1<=1 and 0<=y0<y1<=1
  boxes_by_image[image].append(box)
  if mid in wanted:target_boxes[(image,mid)].append(box)
 negatives=[]
 for index,row in enumerate(read_csv('labels.csv'),start=2):
  if row['ImageID'] in metadata and row['LabelName'] in wanted and row['Confidence']=='0' and row['Source']=='verification' and (row['ImageID'],row['LabelName']) not in target_boxes:
   negatives.append({'imageId':row['ImageID'],'targetClassId':row['LabelName'],'target':classes[row['LabelName']],'primaryStratum':'negative','targetBoxes':[],'negativeEvidence':{'type':'explicit-human-verified-image-label','source':row['Source'],'confidence':0,'sourceCsvRow':index,'sourceFile':'source/labels.csv'},'tags':['negative']})
 candidates=defaultdict(list)
 for (image,mid),boxes in target_boxes.items():
  if any(b['groupOf']!=0 or b['depiction']!=0 for b in boxes):continue
  tags=[]
  if any(.0005<=(b['xyxy'][2]-b['xyxy'][0])*(b['xyxy'][3]-b['xyxy'][1])<=.01 for b in boxes):tags.append('small')
  if any(b['truncated']==1 and min(b['xyxy'][0],b['xyxy'][1],1-b['xyxy'][2],1-b['xyxy'][3])<=.01 for b in boxes):tags.append('edge')
  if any(b['occluded']==1 for b in boxes):tags.append('occluded')
  if 2<=len(boxes)<=8:tags.append('duplicate')
  if len(boxes)==1 and boxes[0]['occluded']==0 and boxes[0]['truncated']==0 and .04<=(boxes[0]['xyxy'][2]-boxes[0]['xyxy'][0])*(boxes[0]['xyxy'][3]-boxes[0]['xyxy'][1])<=.8:tags.append('baseline')
  for tag in tags:candidates[tag].append({'imageId':image,'targetClassId':mid,'target':classes[mid],'primaryStratum':tag,'targetBoxes':boxes,'negativeEvidence':None,'tags':tags})
 candidates['negative']=negatives
 for tag,items in candidates.items():items.sort(key=lambda r:sha((SEED+'/'+tag+'/'+r['imageId']+'/'+r['targetClassId']).encode()))
 print('candidate counts',json.dumps({k:len(v) for k,v in candidates.items()}),flush=True)
 records=[];rejections=[];used_images=set();used_authors=set();used_hashes=set();class_counts=Counter();cursors=Counter()
 # Select across both splits before any model exists. Author groups and image IDs
 # never cross split boundaries. Quotas/prompt wording do not depend on responses.
 for split,quotas in QUOTAS.items():
  for tag,count in quotas.items():
   accepted=0
   while accepted<count:
    batch=[];batch_authors=set()
    while len(batch)<min(4,count-accepted) and cursors[tag]<len(candidates[tag]):
     candidate=candidates[tag][cursors[tag]];cursors[tag]+=1
     image=candidate['imageId'];author=metadata[image]['AuthorProfileURL'].rstrip('/')
     if image in used_images or author in used_authors or author in batch_authors or class_counts[candidate['targetClassId']]>=4:continue
     batch.append(candidate);batch_authors.add(author)
    if not batch:raise RuntimeError('exhausted candidates '+split+'/'+tag)
    with ThreadPoolExecutor(max_workers=4) as pool:
     futures=[pool.submit(get_photo,c,metadata) for c in batch]
     for candidate,future in zip(batch,futures):
      try:record=future.result()
      except Exception as error:
       rejections.append({'imageId':candidate['imageId'],'stratum':tag,'stage':'license-or-image','errorType':type(error).__name__,'detail':str(error)[:200]});print('reject',candidate['imageId'],type(error).__name__,flush=True);continue
      if record['sha256'] in used_hashes:rejections.append({'imageId':record['imageId'],'stage':'dedup','detail':'identical bytes'});continue
      record['split']=split;record['caseId']='photo-'+split+'-'+str(sum(r['split']==split for r in records)+1).zfill(2)
      records.append(record);used_images.add(record['imageId']);used_authors.add(record['authorGroup']);used_hashes.add(record['sha256']);class_counts[record['targetClassId']]+=1;accepted+=1
      print('accepted',record['caseId'],tag,record['target'],record['imageId'],flush=True)
      (ROOT/'photo-progress.json').write_text(json.dumps({'records':records,'rejections':rejections},ensure_ascii=False,indent=2)+'\n')
 (ROOT/'photo-manifest.json').write_text(json.dumps({'version':1,'seed':SEED,'createdAt':now(),'expectedCounts':{'dev':20,'heldout':40},'independentOfModelOutputs':True,'licensePolicy':{'code':'MIT','photos':'CC-BY-2.0','annotations':'CC-BY-4.0','photosRelicensedAsMIT':False},'quotas':QUOTAS,'sourceManifestSha256':sha((ROOT/'source-manifest.json').read_bytes()),'cases':records,'rejections':rejections},ensure_ascii=False,indent=2)+'\n')
 for split in QUOTAS:
  selected=[r for r in records if r['split']==split]
  requests=[{'caseId':r['caseId'],'image':{'path':r['file'],'sha256':r['sha256'],'width':r['width'],'height':r['height']},'locate':{'target':r['target'],'instruction':'Locate every visible physical instance of the named object class. Return unknown if not supported; do not infer position from unseen content.'},'classify':{'question':'Does this photograph contain a physical '+r['target']+'?','options':['present','absent']}} for r in selected]
  gt=[{'caseId':r['caseId'],'expectedPresence':'absent' if r['negativeEvidence'] else 'present','targetBoxes':r['targetBoxes'],'negativeEvidence':r['negativeEvidence'],'allAnnotatedBoxes':boxes_by_image[r['imageId']],'annotationLicense':'https://creativecommons.org/licenses/by/4.0/','stratum':r['primaryStratum'],'tags':r['tags']} for r in selected]
  (ROOT/'inputs'/(split+'.json')).write_text(json.dumps(requests,ensure_ascii=False,indent=2)+'\n');(ROOT/'ground-truth'/(split+'.json')).write_text(json.dumps(gt,ensure_ascii=False,indent=2)+'\n')
 print('DONE',json.dumps({'photos':len(records),'bySplit':dict(Counter(r['split'] for r in records)),'rejections':len(rejections)}),flush=True)
if __name__=='__main__':prepare()
