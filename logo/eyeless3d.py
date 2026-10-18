import numpy as np;from PIL import Image;from scipy import ndimage as nd
a=np.array(Image.open('blob-3d.png').convert('RGBA')).astype(float);H,W=a.shape[:2]
Y,X=np.mgrid[0:H,0:W];o=a.copy();rng=np.random.default_rng(1)
for cx,cy in ((219.5,293),(375.5,293)):
  rx,ry=40,46
  r=np.sqrt(((X-cx)/rx)**2+((Y-cy)/ry)**2)
  ring=(r>1.05)&(r<1.6)&(a[...,3]>250)
  A=lambda x,y:np.stack([np.ones_like(x),x,y,x*x,x*y,y*y,x**3,y**3,x*x*y,x*y*y],-1)
  xs=(X[ring]-cx)/rx;ys=(Y[ring]-cy)/ry
  fill=np.zeros((H,W,3))
  for c in range(3):
    co,*_=np.linalg.lstsq(A(xs,ys),a[...,c][ring],rcond=None)
    fill[...,c]=A((X-cx)/rx,(Y-cy)/ry)@co
  resid=np.std(a[...,1][ring]-(A(xs,ys)@np.linalg.lstsq(A(xs,ys),a[...,1][ring],rcond=None)[0]))
  noise=nd.gaussian_filter(rng.normal(0,1,(H,W)),0.8);noise*=resid*0.6/noise.std()
  w=np.clip((1.12-r)/0.12,0,1)[...,None]
  o[...,:3]=o[...,:3]*(1-w)+(fill+noise[...,None])*w
o=np.clip(o,0,255).astype(np.uint8);Image.fromarray(o).save('blob-3d-eyeless.png')
