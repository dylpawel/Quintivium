# ════════════════════════════════════════════════════════════════════════════
# CONFIGURATION — edit these values, then run the script
# ════════════════════════════════════════════════════════════════════════════
$nPlain  = 4    # number of plain-grass variants
$nTurfy  = 2    # number of turfy-grass variants
$nGravel = 2    # number of scattered-gravel variants
$nFlower = 1    # number of flower variants
# ════════════════════════════════════════════════════════════════════════════
# Output: ../world/grass.png   (relative to this script)
# Tileset JSON is patched automatically with the new variant count.
# grass_old.png is used as the alpha-mask source; it is never overwritten.
# ════════════════════════════════════════════════════════════════════════════

Add-Type -AssemblyName System.Drawing

$scriptDir  = Split-Path $MyInvocation.MyCommand.Path
$worldDir   = Join-Path $scriptDir '..\world'
$outPath    = Join-Path $worldDir  'grass.png'
$maskPath   = Join-Path $worldDir  'grass_old.png'
$tilesetJson= Join-Path $worldDir  'tileset.json'

$total = $nPlain + $nTurfy + $nGravel + $nFlower
Write-Host "Variants: plain=$nPlain  turfy=$nTurfy  gravel=$nGravel  flower=$nFlower  (total=$total)"

Add-Type @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class GrassGen2 {

    // ── RNG: two-round xor-multiply hash, matches grassTiles.js ──────────────
    static uint s;
    static void Seed(uint seed) { s = seed == 0 ? 1u : seed; }
    static double Rng() {
        unchecked { s ^= s >> 16; s *= 0x45d9f3bu; s ^= s >> 16; s *= 0x45d9f3bu; }
        return s / 4294967296.0;
    }
    static int RI(int n) { int v=(int)(Rng()*n); return v>=n?n-1:v; }

    // ── Color helpers ─────────────────────────────────────────────────────────
    static byte Cl(double v) { return (byte)Math.Round(Math.Max(0,Math.Min(255,v))); }
    static byte[] Dk(int r,int g,int b,double a){ double f=1-a; return new byte[]{Cl(r*f),Cl(g*f),Cl(b*f)}; }
    static byte[] Lt(int r,int g,int b,double a){ return new byte[]{Cl(r+(255-r)*a),Cl(g+(255-g)*a),Cl(b+(255-b)*a)}; }

    // ── BASE = #2F8136 ────────────────────────────────────────────────────────
    const int BR=47, BG=129, BB=54;

    static byte[][] pal, palPlain, palPlain2, blades;
    static byte[] cD28, cL22, cD20, cD30, cL25;

    static void Init(){
        // Full 4-shade palette — used by turfy, gravel, flower
        pal=new byte[4][];
        pal[0]=new byte[]{(byte)BR,(byte)BG,(byte)BB};
        pal[1]=Dk(BR,BG,BB,0.08);
        pal[2]=Lt(BR,BG,BB,0.09);
        pal[3]=Dk(BR,BG,BB,0.14);
        // Plain palette: [base, base-7%, base+8%, base-12%]
        palPlain2=new byte[4][];
        palPlain2[0]=new byte[]{(byte)BR,(byte)BG,(byte)BB};
        palPlain2[1]=Dk(BR,BG,BB,0.07);
        palPlain2[2]=Lt(BR,BG,BB,0.08);
        palPlain2[3]=Dk(BR,BG,BB,0.12);
        // Legacy plain (unused)
        palPlain=new byte[2][];
        palPlain[0]=new byte[]{(byte)BR,(byte)BG,(byte)BB};
        palPlain[1]=Dk(BR,BG,BB,0.07);
        blades=new byte[4][]{Dk(BR,BG,BB,0.25),Dk(BR,BG,BB,0.15),Lt(BR,BG,BB,0.20),Lt(BR,BG,BB,0.30)};
        cD28=Dk(BR,BG,BB,0.28); cL22=Lt(BR,BG,BB,0.22); cD20=Dk(BR,BG,BB,0.20);
        cD30=Dk(BR,BG,BB,0.30); cL25=Lt(BR,BG,BB,0.25);
    }

    static byte[] NewTile(){ var t=new byte[32*32*4]; for(int i=3;i<t.Length;i+=4) t[i]=255; return t; }
    static void Put(byte[] t,int x,int y,byte r,byte g,byte b){
        if(x<0||x>=32||y<0||y>=32) return;
        int i=(y*32+x)*4; t[i]=b; t[i+1]=g; t[i+2]=r; t[i+3]=255;
    }

    // Smooth base — 4-shade palette with smear pass
    static void SmoothBase(byte[] t){
        for(int y=0;y<32;y++) for(int x=0;x<32;x++){
            int ci=RI(4); if(Rng()>0.55) ci=RI(4);
            Put(t,x,y,pal[ci][0],pal[ci][1],pal[ci][2]);
        }
    }

    // Plain base — 2-shade palette, 80% chance base, no smear
    // Produces an even, undisturbed surface.
    static void PlainBase(byte[] t){
        for(int y=0;y<32;y++) for(int x=0;x<32;x++){
            // 80 % base, 20 % slightly darker neighbour — avoids banding
            int ci = Rng() < 0.80 ? 0 : 1;
            Put(t,x,y,palPlain[ci][0],palPlain[ci][1],palPlain[ci][2]);
        }
    }

    // Scratch — short angled strokes
    static void Scratch(byte[] t,int n){
        for(int i=0;i<n;i++){
            int sx=RI(30)+1,sy=RI(30)+1,len=RI(3)+1,dir=Rng()>0.5?1:-1;
            int ey=sy+RI(2),ex=sx+dir*len;
            byte[] c=Rng()>0.5?cL22:cD28;
            int ddx=ex-sx,ddy=ey-sy,steps=Math.Max(Math.Abs(ddx),Math.Abs(ddy));
            if(steps<1) steps=1;
            for(int t2=0;t2<=steps;t2++){
                int px=(int)Math.Round(sx+ddx*(double)t2/steps);
                int py=(int)Math.Round(sy+ddy*(double)t2/steps);
                Put(t,px,py,c[0],c[1],c[2]);
            }
        }
    }

    // Turf clusters
    static void Turf(byte[] t,int clusters){
        for(int i=0;i<clusters;i++){
            int cx=RI(26)+3,cy=RI(22)+5,nb=RI(3)+2;
            for(int b=0;b<nb;b++){
                int bx=cx+b-nb/2,h=RI(3)+2;
                for(int row=0;row<h;row++){
                    int px=bx+(row==h-1?(Rng()>0.5?1:-1):0);
                    byte[] c=blades[RI(4)];
                    Put(t,px,cy-row,c[0],c[1],c[2]);
                }
            }
        }
    }

    // ── Four tile generators ──────────────────────────────────────────────────

    // PLAIN — smoothBase (plain palette) + scratch×14 + dots×5
    public static byte[] PlainGrass(uint seed){
        Seed(seed);
        var t=NewTile();
        // smoothBase with plain-specific palette
        for(int y=0;y<32;y++) for(int x=0;x<32;x++){
            int ci=RI(4); if(Rng()>0.55) ci=RI(4);
            Put(t,x,y,palPlain2[ci][0],palPlain2[ci][1],palPlain2[ci][2]);
        }
        // scratch ×14: dark=base-30%, light=base+25%
        for(int i=0;i<14;i++){
            int sx=RI(30)+1,sy=RI(30)+1,len=RI(3)+1,dir=Rng()>0.5?1:-1;
            int ey=sy+RI(2),ex=sx+dir*len;
            byte[] c=Rng()>0.5?cL25:cD30;
            int ddx=ex-sx,ddy=ey-sy,steps=Math.Max(Math.Abs(ddx),Math.Abs(ddy));
            if(steps<1) steps=1;
            for(int t2=0;t2<=steps;t2++){
                int px=(int)Math.Round(sx+ddx*(double)t2/steps);
                int py=(int)Math.Round(sy+ddy*(double)t2/steps);
                Put(t,px,py,c[0],c[1],c[2]);
            }
        }
        // dots ×5 — dark anchor points base-20%
        for(int i=0;i<5;i++) Put(t,RI(32),RI(32),cD20[0],cD20[1],cD20[2]);
        return t;
    }

    // TURFY — textured base + visible blade clusters
    public static byte[] TurfyGrass(uint seed){
        Seed(seed); var t=NewTile(); SmoothBase(t); Scratch(t,5); Turf(t,7); return t;
    }

    // SCATTERED GRAVEL
    public static byte[] ScatteredGravel(uint seed){
        Seed(seed); var t=NewTile(); SmoothBase(t); Scratch(t,6);
        byte[][] grav={
            new byte[]{0x88,0x70,0x60},new byte[]{0x78,0x60,0x50},
            new byte[]{0xa0,0x88,0x78},new byte[]{0x68,0x58,0x48},
            new byte[]{0xb0,0x98,0x8a}};
        for(int i=0;i<15;i++){
            int gx=RI(32),gy=RI(32),w=Rng()>0.6?2:1,h=Rng()>0.7?2:1;
            byte[] c=grav[RI(5)];
            for(int dy=0;dy<h;dy++) for(int dx=0;dx<w;dx++) Put(t,gx+dx,gy+dy,c[0],c[1],c[2]);
            if(w>1||h>1){
                if(h>1&&gx+w-1<32&&gy+1<32){
                    int ii=((gy+1)*32+(gx+w-1))*4;
                    t[ii]=(byte)(t[ii]*0.78);t[ii+1]=(byte)(t[ii+1]*0.78);t[ii+2]=(byte)(t[ii+2]*0.78);
                }
                for(int dx=0;dx<w-1;dx++){
                    if(gx+dx<32&&gy<32){
                        int ii=(gy*32+(gx+dx))*4;
                        t[ii]  =(byte)Math.Min(255,t[ii]  +(255-t[ii]  )*0.20);
                        t[ii+1]=(byte)Math.Min(255,t[ii+1]+(255-t[ii+1])*0.20);
                        t[ii+2]=(byte)Math.Min(255,t[ii+2]+(255-t[ii+2])*0.20);
                    }
                }
            }
        }
        return t;
    }

    // FLOWERS
    public static byte[] Flowers(uint seed){
        Seed(seed); var t=NewTile(); SmoothBase(t); Scratch(t,7); Turf(t,3);
        byte[][] pet={
            new byte[]{0xf5,0xe0,0x40},new byte[]{0xff,0xff,0xff},
            new byte[]{0xf5,0xc5,0x18},new byte[]{0xe8,0xf0,0x80}};
        for(int i=0;i<4;i++){
            int fx=RI(28)+2,fy=RI(28)+2;
            Put(t,fx,fy+1,0x1e,0x5c,0x10); Put(t,fx,fy+2,0x1e,0x5c,0x10);
            byte[] p=pet[RI(4)];
            Put(t,fx-1,fy,p[0],p[1],p[2]); Put(t,fx,fy,p[0],p[1],p[2]); Put(t,fx+1,fy,p[0],p[1],p[2]);
            Put(t,fx,fy-1,p[0],p[1],p[2]); Put(t,fx,fy+1,p[0],p[1],p[2]);
            Put(t,fx,fy,0xe0,0x90,0x10);
        }
        return t;
    }

    // ── Edge shading: 3 BFS passes from transparent pixels ───────────────────
    // pass 1 touching alpha==0 → darken 30 %
    // pass 2 touching pass-1    → darken 15 %
    // pass 3 touching pass-2    → darken  7 %
    static float[] BuildShading(byte[] a){
        var sh=new float[1024];
        var e1=new bool[1024]; var e2=new bool[1024];
        for(int y=0;y<32;y++) for(int x=0;x<32;x++){
            int idx=y*32+x; if(a[idx]==0) continue;
            bool f=false;
            for(int dy=-1;dy<=1&&!f;dy++) for(int dx=-1;dx<=1&&!f;dx++){
                if(dx==0&&dy==0) continue;
                int nx=x+dx,ny=y+dy;
                if(nx>=0&&nx<32&&ny>=0&&ny<32&&a[ny*32+nx]==0) f=true;
            }
            if(f){e1[idx]=true;sh[idx]=0.30f;}
        }
        for(int y=0;y<32;y++) for(int x=0;x<32;x++){
            int idx=y*32+x; if(a[idx]==0||e1[idx]) continue;
            bool f=false;
            for(int dy=-1;dy<=1&&!f;dy++) for(int dx=-1;dx<=1&&!f;dx++){
                if(dx==0&&dy==0) continue;
                int nx=x+dx,ny=y+dy;
                if(nx>=0&&nx<32&&ny>=0&&ny<32&&e1[ny*32+nx]) f=true;
            }
            if(f){e2[idx]=true;sh[idx]=0.15f;}
        }
        for(int y=0;y<32;y++) for(int x=0;x<32;x++){
            int idx=y*32+x; if(a[idx]==0||e1[idx]||e2[idx]) continue;
            bool f=false;
            for(int dy=-1;dy<=1&&!f;dy++) for(int dx=-1;dx<=1&&!f;dx++){
                if(dx==0&&dy==0) continue;
                int nx=x+dx,ny=y+dy;
                if(nx>=0&&nx<32&&ny>=0&&ny<32&&e2[ny*32+nx]) f=true;
            }
            if(f) sh[idx]=0.07f;
        }
        return sh;
    }

    // ── Main entry point ──────────────────────────────────────────────────────
    // generators: array of (generatorIndex, variantIndex) pairs in sheet row order
    // generatorIndex: 0=Plain 1=Turfy 2=Gravel 3=Flower
    public static void Generate(string maskPath, string outPath, int[] order){
        Init();

        // Load alpha mask from grass_old.png (row 0 only)
        var mb=new Bitmap(maskPath);
        var md=mb.LockBits(new Rectangle(0,0,mb.Width,mb.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
        int mw=mb.Width;
        byte[] mp=new byte[mw*mb.Height*4];
        Marshal.Copy(md.Scan0,mp,0,mp.Length);
        mb.UnlockBits(md); mb.Dispose();

        byte[][] alphas=new byte[16][];
        float[][] shadings=new float[16][];
        for(int mask=1;mask<16;mask++){
            byte[] a=new byte[1024];
            int ox=mask*32;
            for(int py=0;py<32;py++) for(int px=0;px<32;px++)
                a[py*32+px]=mp[(py*mw+(ox+px))*4+3];
            alphas[mask]=a; shadings[mask]=BuildShading(a);
        }

        // Base seeds per generator type (base*997, then +v*31337 per variant)
        uint[] bases={161u*997u, 178u*997u, 195u*997u, 212u*997u};
        // variant counters per type
        int[] vcnt=new int[4];

        int total=order.Length;
        var sheet=new Bitmap(512,total*32,PixelFormat.Format32bppArgb);
        var sd=sheet.LockBits(new Rectangle(0,0,512,total*32),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
        byte[] sp=new byte[512*total*32*4];

        for(int row=0;row<total;row++){
            int gen=order[row];
            uint seed=unchecked(bases[gen]+(uint)(vcnt[gen]*31337));
            vcnt[gen]++;
            byte[] tile;
            switch(gen){
                case 0: tile=PlainGrass(seed);      break;
                case 1: tile=TurfyGrass(seed);       break;
                case 2: tile=ScatteredGravel(seed);  break;
                default:tile=Flowers(seed);           break;
            }
            for(int mask=1;mask<16;mask++){
                byte[] a=alphas[mask]; float[] sh=shadings[mask];
                int dstX=mask*32, dstY=row*32;
                for(int py=0;py<32;py++) for(int px=0;px<32;px++){
                    int ai=py*32+px; byte alpha=a[ai]; if(alpha==0) continue;
                    int ti=ai*4; float f=1f-sh[ai];
                    int di=((dstY+py)*512+(dstX+px))*4;
                    sp[di]  =(byte)(tile[ti]  *f);
                    sp[di+1]=(byte)(tile[ti+1]*f);
                    sp[di+2]=(byte)(tile[ti+2]*f);
                    sp[di+3]=alpha;
                }
            }
        }

        Marshal.Copy(sp,0,sd.Scan0,sp.Length);
        sheet.UnlockBits(sd);
        sheet.Save(outPath,ImageFormat.Png);
        sheet.Dispose();
    }
}
"@ -ReferencedAssemblies 'System.Drawing'

# Build row order: all plain first, then turfy, then gravel, then flower
# (0=plain, 1=turfy, 2=gravel, 3=flower)
$order = @()
for ($i = 0; $i -lt $nPlain;  $i++) { $order += 0 }
for ($i = 0; $i -lt $nTurfy;  $i++) { $order += 1 }
for ($i = 0; $i -lt $nGravel; $i++) { $order += 2 }
for ($i = 0; $i -lt $nFlower; $i++) { $order += 3 }

Write-Host "Generating $total variants..."
[GrassGen2]::Generate($maskPath, $outPath, [int[]]$order)
Write-Host "Done. grass.png: 512x$($total * 32) ($total rows)"

# Patch tileset.json — update the "variants" field on the grass terrain
$json = Get-Content $tilesetJson -Raw
$json = $json -replace '("name"\s*:\s*"grass"[^}]*?"sprite"\s*:\s*"grass\.png"[^}]*?)"variants"\s*:\s*\d+', "`$1`"variants`": $total"
# If no variants field exists yet, insert it
if ($json -notmatch '"name"\s*:\s*"grass"[^}]*"variants"') {
    $json = $json -replace '("name"\s*:\s*"grass"[^}]*?"tags"\s*:\s*\[[^\]]*\])', "`$1, `"variants`": $total"
}
Set-Content $tilesetJson $json -NoNewline
Write-Host "tileset.json patched: grass variants = $total"
