# Claw Marks geometry generator. 64x64 viewBox, stroke 8 (radius 4 round caps), all endpoints on integer coords.
# Each stroke: centerline through (cx, cy) with slope tan(theta) from vertical; half-height h -> endpoints (cx -/+ h*t, cy +/- h).
import math,json
V={"a":dict(t=0.4,p=16,name="slant"),"b":dict(t=0.2,p=15,name="upright")}
W=8; HM=20; HO=15; DY=5   # middle half-height, outer half-height, outer vertical center offset (down, same for both)
LIME="#C6FF3D"; INK="#0A0A0A"
def strokes(t,p):
    out=[]
    for cx,cy,h in [(32-p,32+DY,HO),(32,32,HM),(32+p,32+DY,HO)]:
        dx=h*t; assert dx==int(dx)
        out.append((cx-dx,cy+h,cx+dx,cy-h))
    return out
def paths(s): return "".join(f'<path d="M{x1:g} {y1:g} L{x2:g} {y2:g}"/>' for x1,y1,x2,y2 in s)
def g(s,col): return f'<g fill="none" stroke="{col}" stroke-linecap="round" stroke-width="{W}">{paths(s)}</g>'
def svg(body,vb="0 0 64 64",w=64,h=64): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" role="img" aria-label="StockClaw">{body}</svg>\n'
TILE=lambda c:f'<rect width="64" height="64" rx="14" fill="{c}"/>'
WORD='<g fill="#C6FF3D"><text x="76" y="44" font-family="Inter,Helvetica,Arial,sans-serif" font-size="34" font-weight="600" letter-spacing="-1.2">stockclaw</text></g>'
info={}
for k,v in V.items():
    s=strokes(v["t"],v["p"]);xs=[c for st in s for c in (st[0],st[2])];ys=[c for st in s for c in (st[1],st[3])]
    bb=(min(xs)-W/2,min(ys)-W/2,max(xs)+W/2,max(ys)+W/2)
    th=math.degrees(math.atan(v["t"]));gap=v["p"]*math.cos(math.atan(v["t"]))-W
    info[k]=dict(variant=v["name"],angle_from_vertical_deg=round(th,2),slope=f'{v["t"]}',pitch_px=v["p"],perp_gap_px=round(gap,2),stroke=W,
      middle_len=round(2*HM/math.cos(math.atan(v["t"])),2),outer_len=round(2*HO/math.cos(math.atan(v["t"])),2),outer_center_dy=DY,bbox=bb,bbox_center=((bb[0]+bb[2])/2,(bb[1]+bb[3])/2),strokes=s)
    open(f"mark-{k}.svg","w").write(svg(TILE(INK)+g(s,LIME)))
    open(f"mark-{k}-transparent.svg","w").write(svg(g(s,LIME)))
    open(f"mark-{k}-mono-black-on-lime.svg","w").write(svg(TILE(LIME)+g(s,INK)))
    open(f"mark-{k}-mono.svg","w").write(svg(g(s,"currentColor")))
    open(f"lockup-{k}.svg","w").write(svg(g(s,LIME)+WORD,"0 0 250 64",250,64))
    open(f"lockup-{k}-mono-black.svg","w").write(svg(g(s,INK)+WORD.replace("#C6FF3D",INK),"0 0 250 64",250,64))
    open(f"favicon-{k}.svg","w").write(svg(TILE(INK)+g(s,LIME)))
    open(f"app-icon-{k}.svg","w").write(svg(f'<rect width="64" height="64" fill="{INK}"/>'+g(s,LIME)))  # full-bleed; OS applies its own mask
json.dump(info,open("geometry.json","w"),indent=1)
print(json.dumps(info,indent=1))
