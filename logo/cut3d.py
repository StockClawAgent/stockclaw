# Color-key cutout of logo-3d-lime.png (flat #0A0A0A background) with un-premultiplied edges (no dark halo).
from PIL import Image;import numpy as np
a=np.array(Image.open('logo-3d-lime.png').convert('RGB')).astype(float);bg=np.array([10,10,10.])
d=np.abs(a-bg).max(2);al=np.clip((d-8)/52,0,1)        # soft ramp; drops the faint contact shadow (it reads as smudge on #0A0A0A)
from scipy import ndimage as nd
lab,n=nd.label(al>0.5);big=lab==(np.bincount(lab.ravel())[1:].argmax()+1);keep=nd.binary_dilation(big,iterations=6);al=al*keep
# 1px choke on the edge band only: kills the render's dark anti-aliased rim on light backgrounds
from scipy.ndimage import minimum_filter,uniform_filter
ch=uniform_filter(minimum_filter(al,size=3),size=2);al=np.where(al<0.999,np.minimum(al,ch),al)
rgb=np.where(al[...,None]>0.02,(a-bg*(1-al[...,None]))/np.maximum(al[...,None],0.02),0);rgb=np.clip(rgb,0,255)
out=np.dstack([rgb,al*255]).astype(np.uint8);im=Image.fromarray(out,'RGBA');bb=im.getbbox();print('bbox',bb)
im=im.crop(bb);pad=8;W,H=im.size;c=Image.new('RGBA',(W+2*pad,H+2*pad),(0,0,0,0));c.paste(im,(pad,pad));c.save('blob-3d.png');print('size',c.size)
for w in (1024,512,256):
    c.resize((w,round(c.height*w/c.width)),Image.LANCZOS).save(f'blob-3d-{w}.png')
# header heights: 64/128 tall? header uses height 32@1x/64@2x; 64 and 128 widths as requested (@1x/@2x)
for w,tag in ((64,'64'),(128,'128')):
    r=c.resize((w,round(c.height*w/c.width)),Image.LANCZOS);r.save(f'blob-3d-{tag}.png');r.save(f'blob-3d-{tag}.webp',quality=90,method=6)
for w in (256,512):Image.open(f'blob-3d-{w}.png').save(f'blob-3d-{w}.webp',quality=88,method=6)
