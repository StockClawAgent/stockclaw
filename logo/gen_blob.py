# Claw-blob logo generator. Body traced against new-logo-reference.png (IoU ~0.97) and hand-built from 9 cubic segments.
BODY="M74 298C74 250 120 200 150 192C172 186 190 204 206 216C216 224 226 222 236 212C255 192 268 168 288 167C304 167 318 192 334 201C344 206 352 200 360 192C385 165 398 150 414 133C424 124 439 125 436 142L404 290C396 330 376 371 330 371L150 371C105 371 74 340 74 298Z"
LIME="#C6FF3D";INK="#0A0A0A"
def eyes(rx=16,ry=19,cx=(200,291),cy=289): return "".join(f"M{c-rx} {cy}a{rx} {ry} 0 1 0 {2*rx} 0a{rx} {ry} 0 1 0 {-2*rx} 0Z" for c in cx)
def ell(col,**k): return f'<path d="{eyes(**k)}" fill="{col}"/>'
def svg(body,vb="0 0 512 512",w=512,h=512,label="StockClaw"): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" role="img" aria-label="{label}">{body}</svg>\n'
TILE=lambda c,rx=112:f'<rect width="512" height="512" rx="{rx}" fill="{c}"/>'
C="translate(0 7)"  # center the blob's bbox (74..437 x 127..371) in the 512 tile
def blob(eye_col,tf=C,**k): return f'<g transform="{tf}"><path d="{BODY}" fill="{LIME}"/>{ell(eye_col,**k)}</g>'
# small-size variant: blob scaled up 1.16 about the tile center, bigger eyes, so 16/32px keep eyes + peaks
SM="translate(256 256) scale(1.16) translate(-255.5 -249)";SMEYE=dict(rx=27,ry=33,cx=(196,294),cy=292)
W=open('/tmp/blob/word.txt').read()
files={
 "blob-mark.svg":svg(TILE(INK)+blob(INK)),
 "blob-mark-white-eyes.svg":svg(TILE(INK)+blob("#FFFFFF")),
 "blob-mark-transparent.svg":svg(blob(INK,tf="translate(0 0)"),vb="64 117 384 264",w=384,h=264),
 "blob-mono.svg":svg(f'<path fill="currentColor" fill-rule="evenodd" d="{BODY}{eyes()}"/>',vb="64 117 384 264",w=384,h=264),
 "blob-favicon.svg":svg(TILE(INK)+blob(INK)),
 "blob-favicon-small.svg":svg(TILE(INK,96)+blob(INK,tf=SM,**SMEYE)),
 "blob-app-icon.svg":svg(f'<rect width="512" height="512" fill="{INK}"/>'+blob(INK)),
 "blob-lockup.svg":svg(f'<g transform="translate(6 6) scale(0.42) translate(-74 -127)"><path d="{BODY}" fill="{LIME}"/>{ell(INK)}</g><g transform="translate(178 94) scale(0.092 0.092)" fill="{LIME}"><path d="{W}"/></g>',vb="0 0 620 128",w=620,h=128),
 "blob-lockup-mono.svg":svg(f'<g fill="currentColor"><path fill-rule="evenodd" transform="translate(6 6) scale(0.42) translate(-74 -127)" d="{BODY}{eyes()}"/><path transform="translate(178 94) scale(0.092 0.092)" d="{W}"/></g>',vb="0 0 620 128",w=620,h=128),
}
for n,s in files.items(): open(n,"w").write(s)
print(list(files))
