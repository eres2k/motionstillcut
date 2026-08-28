import re,subprocess,sys
def scenes(path):
    out=subprocess.run(["ffmpeg","-hide_banner","-i",path,"-vf","select='gte(scene,0)',metadata=print","-an","-f","null","-"],capture_output=True,text=True).stderr
    fr=re.findall(r"pts_time:([\d.]+)\n.*?scene_score=([\d.]+)",out)
    sc=[(float(a),float(b)) for a,b in fr]
    top=sorted(sc,key=lambda x:-x[1])[:6]
    cuts=[round(a,2) for a,b in sc if b>=0.2]
    return len(sc),[(round(a,2),round(b,2)) for a,b in top],cuts
if __name__=="__main__":
    for p in sys.argv[1:]:
        n,top,cuts=scenes(p); print(p.split('/')[-1],"frames",n,"cuts(>=.2):",cuts,"top:",top)
