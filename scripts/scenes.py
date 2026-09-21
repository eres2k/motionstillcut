import re,subprocess,sys
import numpy as np

# Two columns per clip. Column 1 is the original per-frame scene score (a hard
# cut is one big step). Column 2 is a rolling histogram delta over a short
# window: a dissolve accumulates the same change gradually, so it is invisible
# to column 1 and shows here. Column 2 flags CANDIDATES for the eye, not
# verdicts — the by-eye pass stays the reference, and when they disagree the
# eye wins (2026-09: the per-frame column undercounted an entire corpus, and
# the first cut of this detector missed same-brightness dissolves).
FPS=12          # analysis rate; window maths stays in seconds regardless of source fps
WIN=6           # frames back (=0.5 s) the windowed delta compares against
RATIO=3.0       # window delta over the clip's own median that flags — adaptive,
                # because constant camera motion raises the baseline for the whole clip
FLOOR=0.4       # ...but never flag below this absolute delta
STEP=0.45       # a single-frame step this big inside the window reads as a cut, not a dissolve
                # (0.35 rejected the fast half-second fades in the beach corpus renders)

def scenes(path):
    out=subprocess.run(["ffmpeg","-hide_banner","-i",path,"-vf","select='gte(scene,0)',metadata=print","-an","-f","null","-"],capture_output=True,text=True).stderr
    fr=re.findall(r"pts_time:([\d.]+)\n.*?scene_score=([\d.]+)",out)
    sc=[(float(a),float(b)) for a,b in fr]
    top=sorted(sc,key=lambda x:-x[1])[:6]
    cuts=[round(a,2) for a,b in sc if b>=0.2]
    return len(sc),[(round(a,2),round(b,2)) for a,b in top],cuts

def dissolves(path,cuts=(),w=64,h=36,bx=4,by=3):
    raw=subprocess.run(["ffmpeg","-hide_banner","-i",path,"-vf",f"fps={FPS},scale={w}:{h}","-pix_fmt","gray","-f","rawvideo","-"],capture_output=True).stdout
    fr=np.frombuffer(raw,np.uint8)[:len(raw)//(w*h)*(w*h)].reshape(-1,h,w)
    # Histogram per BLOCK (4×3 grid), not per frame: a reframed shot at the
    # same overall brightness is invisible to a global luma histogram (it
    # missed two by-eye dissolves in the same room on 21 Sep); per-block it
    # is a composition change and shows.
    blocks=fr.reshape(-1,by,h//by,bx,w//bx).transpose(0,1,3,2,4).reshape(len(fr),bx*by,-1)
    hist=np.stack([[np.bincount(b>>3,minlength=32) for b in f] for f in blocks])/(h//by*(w//bx))
    d1=(0.5*np.abs(np.diff(hist,axis=0)).sum(2)).mean(1)                # per-frame delta, mean over blocks
    dw=(0.5*np.abs(hist[WIN:]-hist[:-WIN]).sum(2)).mean(1)              # delta across the window
    th=max(FLOOR,RATIO*float(np.median(dw)))
    hascut=lambda a,b: any(a<=c<=b for c in cuts)                       # already in column 1
    flag=[i for i in range(len(dw)) if dw[i]>=th and d1[i:i+WIN].max()<STEP and not hascut(i/FPS,(i+WIN)/FPS)]
    runs=[]                                                             # merge adjacent frames into ranges
    for i in flag:
        if runs and i-runs[-1][1]<=2: runs[-1][1]=i
        else: runs.append([i,i])
    return [(round(a/FPS,2),round((b+WIN)/FPS,2),round(float(dw[a:b+1].max()),2)) for a,b in runs]

if __name__=="__main__":
    for p in sys.argv[1:]:
        n,top,cuts=scenes(p); dis=dissolves(p,cuts)
        print(p.split('/')[-1],"frames",n,"cuts(>=.2):",cuts,"top:",top)
        print("  dissolve candidates(win):",[f"{a}-{b}s @{s}" for a,b,s in dis] or "none","· candidates for the eye, the by-eye pass is the reference")
