using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class WaterBaker
{
    const int TILE = 32, WAVE = 16;

    static uint Xs(ref uint s){s^=s<<13;s^=s>>17;s^=s<<5;return s;}
    static double D(ref uint s)=>Xs(ref s)/4294967296.0;
    static uint Seed(long v){uint s=(uint)(v&0xFFFFFFFF);return s==0?1:s;}

    static bool IsWater(int r,int g,int b)
        =>(Math.Abs(r-21)<=10&&Math.Abs(g-108)<=10&&Math.Abs(b-153)<=10)
        ||(r<=10&&Math.Abs(g-152)<=10&&Math.Abs(b-178)<=10)
        ||(r<=10&&Math.Abs(g-207)<=10&&Math.Abs(b-223)<=10);

    static void Blend(byte[] d,int i,int r,int g,int b,double a){
        double ia=1-a;
        d[i]  =(byte)Math.Min(255,r*a+d[i]  *ia);
        d[i+1]=(byte)Math.Min(255,g*a+d[i+1]*ia);
        d[i+2]=(byte)Math.Min(255,b*a+d[i+2]*ia);
    }

    struct TD{public byte[] WM,CO;public int[][] Rows;public int[] EX;public int[] EY;public int EC;}
    struct SH{public int X,Y,Len,Phase,HL,CI;}
    struct FM{public int DX,DY,Phase,Per,W,H;public byte[] Stamp;}
    // shimmer color palettes: [0]={0,152,178} [1]={0,207,223}
    static int SR0R=0,SR0G=152,SR0B=178,SR1R=0,SR1G=207,SR1B=223;
    static void SRGet(int ci,out int r,out int g,out int b){if(ci==0){r=SR0R;g=SR0G;b=SR0B;}else{r=SR1R;g=SR1G;b=SR1B;}}

    static TD Analyze(byte[] p){
        var wm=new byte[TILE*TILE*4];var co=new byte[TILE*TILE*4];
        // rows: flat buffer per row, rowLen counts
        int[] rowBuf=new int[TILE*TILE];int[] rowOff=new int[TILE+1];int[] rowLen=new int[TILE];
        for(int y=0;y<TILE;y++)for(int x=0;x<TILE;x++){
            int i=(y*TILE+x)*4,r=p[i],g=p[i+1],b=p[i+2],a=p[i+3];if(a<128)continue;
            if(IsWater(r,g,b)){wm[i]=wm[i+1]=wm[i+2]=255;wm[i+3]=(byte)a;rowLen[y]++;}
            else{co[i]=(byte)r;co[i+1]=(byte)g;co[i+2]=(byte)b;co[i+3]=(byte)a;}
        }
        // build offsets and fill rowBuf
        rowOff[0]=0;for(int y=0;y<TILE;y++)rowOff[y+1]=rowOff[y]+rowLen[y];
        int[] cur=new int[TILE];
        for(int y=0;y<TILE;y++)for(int x=0;x<TILE;x++){
            int i=(y*TILE+x)*4;if(wm[i+3]==0)continue;
            rowBuf[rowOff[y]+cur[y]++]=x;
        }
        var rows=new int[TILE][];
        for(int y=0;y<TILE;y++){rows[y]=new int[rowLen[y]];Array.Copy(rowBuf,rowOff[y],rows[y],0,rowLen[y]);}
        // edges
        int[] ex=new int[TILE*TILE],ey=new int[TILE*TILE];int ec=0;
        for(int y=0;y<TILE;y++)foreach(int x in rows[y]){
            int[] nx={x-1,x+1,x,x},ny={y,y,y-1,y+1};
            for(int k=0;k<4;k++){int qx=nx[k],qy=ny[k];if(qx<0||qx>=TILE||qy<0||qy>=TILE)continue;
                if(co[(qy*TILE+qx)*4+3]>0){ex[ec]=x;ey[ec]=y;ec++;break;}}
        }
        return new TD{WM=wm,CO=co,Rows=rows,EX=ex,EY=ey,EC=ec};
    }

    static SH[] Shimmers(int[][] rows,int m){
        uint s=Seed(unchecked((long)m*2654435769L^(long)(uint)0xdeadbeef));
        int tot=0;foreach(var r in rows)tot+=r.Length;
        int n=Math.Max(1,Math.Min(8,(tot+90)/180));
        int[] uArr=new int[TILE];int uCnt=0;
        for(int y=0;y<rows.Length;y++)if(rows[y].Length>=3)uArr[uCnt++]=y;
        if(uCnt==0)return new SH[0];
        SH[] o=new SH[n];int oc=0;
        for(int i=0,t=0;i<n&&t<n*12;t++){
            int y=uArr[(int)(D(ref s)*uCnt)];var row=rows[y];int si=(int)(D(ref s)*row.Length);
            int run=1;while(run<row.Length-si&&row[si+run]==row[si+run-1]+1)run++;
            if(run<2)continue;
            o[oc++]=new SH{X=row[si],Y=y,Len=Math.Min(run,2+(int)(D(ref s)*3)),
                Phase=(int)(D(ref s)*WAVE),HL=2+(int)(D(ref s)*3),CI=D(ref s)<0.35?1:0};
            i++;
        }
        var ret=new SH[oc];Array.Copy(o,ret,oc);return ret;
    }

    static byte[] Stamp(int w,int h,int ci){
        var d=new byte[w*h*4];double cx=(w-1)/2.0,cy=(h-1)/2.0,rx=w/2.0,ry=Math.Max(0.5,h/2.0);
        int sr,sg,sb;SRGet(ci,out sr,out sg,out sb);
        for(int py=0;py<h;py++)for(int px=0;px<w;px++){
            double ddx=(px-cx)/rx,ddy=(py-cy)/ry,d2=ddx*ddx+ddy*ddy;if(d2>=1)continue;
            int i=(py*w+px)*4;d[i]=(byte)sr;d[i+1]=(byte)sg;d[i+2]=(byte)sb;d[i+3]=(byte)((1-d2)*255);
        }
        return d;
    }

    static FM[] Foam(int[] ex,int[] ey,int ec,int m,int ow,int oh){
        if(ec==0)return new FM[0];
        uint s=Seed(unchecked((long)(m+99)*(long)(uint)0x9e3779b9^(long)(uint)0xfeedface));
        FM[] o=new FM[32];
        for(int i=0;i<32;i++){
            int pi=(int)(D(ref s)*ec);
            int ph=(int)(D(ref s)*WAVE),per=8+(int)(D(ref s)*7);
            int h=1+(int)(D(ref s)*oh),wm=Math.Min(2*h,ow),w=wm+(int)(D(ref s)*(ow-wm+1));
            o[i]=new FM{DX=ex[pi]-((w-1)>>1),DY=ey[pi]-((h-1)>>1),
                Stamp=Stamp(w,h,D(ref s)<0.65?1:0),W=w,H=h,Phase=ph,Per=per};
        }
        return o;
    }

    static byte[] Frame(TD td,SH[] sh,FM[] fm,int f){
        var px=new byte[TILE*TILE*4];
        for(int j=0;j<TILE*TILE;j++){px[j*4]=21;px[j*4+1]=108;px[j*4+2]=153;px[j*4+3]=255;}
        foreach(var s in sh){
            int raw=((f-s.Phase)%WAVE+WAVE)%WAVE;
            double a=Math.Max(0,1-Math.Min(raw,WAVE-raw)/(double)s.HL);if(a<0.01)continue;
            int scr,scg,scb;SRGet(s.CI,out scr,out scg,out scb);
            for(int sx=0;sx<s.Len;sx++){int ex=s.X+sx;if(ex<0||ex>=TILE)continue;Blend(px,(s.Y*TILE+ex)*4,scr,scg,scb,a);}
        }
        foreach(var fp in fm){
            int raw=((f-fp.Phase)%fp.Per+fp.Per*100)%fp.Per;
            double a=Math.Max(0,1-2*Math.Abs(raw/(double)fp.Per-0.5))*0.5;if(a<0.01)continue;
            for(int sy=0;sy<fp.H;sy++)for(int sx=0;sx<fp.W;sx++){
                int si=(sy*fp.W+sx)*4;double sa=fp.Stamp[si+3]/255.0*a;if(sa<0.01)continue;
                int tx=fp.DX+sx,ty=fp.DY+sy;if(tx<0||tx>=TILE||ty<0||ty>=TILE)continue;
                Blend(px,(ty*TILE+tx)*4,fp.Stamp[si],fp.Stamp[si+1],fp.Stamp[si+2],sa);
            }
        }
        // destination-in with waterMask
        for(int j=0;j<TILE*TILE;j++)px[j*4+3]=(byte)(px[j*4+3]*td.WM[j*4+3]/255);
        // source-over with cliffOnly
        for(int j=0;j<TILE*TILE;j++){
            double ca=td.CO[j*4+3]/255.0;if(ca<0.004)continue;
            int i=j*4;double ia=1-ca;
            px[i]  =(byte)(td.CO[i]  *ca+px[i]  *ia);
            px[i+1]=(byte)(td.CO[i+1]*ca+px[i+1]*ia);
            px[i+2]=(byte)(td.CO[i+2]*ca+px[i+2]*ia);
            px[i+3]=(byte)Math.Min(255,td.CO[i+3]+px[i+3]*ia);
        }
        return px;
    }

    public static void Bake(string inp, string outp){
        byte[] src; int sw, sh;
        using(var bmp=new Bitmap(inp)){
            sw=bmp.Width; sh=bmp.Height;
            var bd=bmp.LockBits(new Rectangle(0,0,sw,sh),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
            src=new byte[sw*sh*4]; Marshal.Copy(bd.Scan0,src,0,src.Length); bmp.UnlockBits(bd);
        }
        int aw=WAVE*TILE, ah=15*TILE; var atl=new byte[aw*ah*4];
        for(int m=1;m<=15;m++){
            var tile=new byte[TILE*TILE*4];
            // Extract tile and convert GDI+ BGRA -> RGBA
            for(int y=0;y<TILE;y++)for(int x=0;x<TILE;x++){
                int si=(y*sw+m*TILE+x)*4, di=(y*TILE+x)*4;
                tile[di]=src[si+2]; tile[di+1]=src[si+1]; tile[di+2]=src[si]; tile[di+3]=src[si+3];
            }
            var td=Analyze(tile);
            var shs=Shimmers(td.Rows,m);
            bool bc=((m&8)!=0&&(m&2)==0)||((m&4)!=0&&(m&1)==0);
            var fm=Foam(td.EX,td.EY,td.EC,m,bc?10:20,bc?2:4);
            for(int f=0;f<WAVE;f++){
                var fr=Frame(td,shs,fm,f);
                int axo=f*TILE, ayo=(m-1)*TILE;
                // Write frame to atlas, converting RGBA -> BGRA for GDI+
                for(int y=0;y<TILE;y++)for(int x=0;x<TILE;x++){
                    int si=(y*TILE+x)*4, di=((ayo+y)*aw+(axo+x))*4;
                    atl[di]=fr[si+2]; atl[di+1]=fr[si+1]; atl[di+2]=fr[si]; atl[di+3]=fr[si+3];
                }
            }
        }
        using(var bmp=new Bitmap(aw,ah,PixelFormat.Format32bppArgb)){
            var bd=bmp.LockBits(new Rectangle(0,0,aw,ah),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
            Marshal.Copy(atl,0,bd.Scan0,atl.Length); bmp.UnlockBits(bd);
            bmp.Save(outp,ImageFormat.Png);
        }
    }
}
