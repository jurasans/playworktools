import sharp from 'sharp'
import fs from 'node:fs'
const [,, dir, out, cols, cw, ch] = process.argv
const files = fs.readdirSync(dir).filter(f=>f.endsWith('.png')).sort()
const C=+cols, W=+cw, H=+ch, rows=Math.ceil(files.length/C)
const comps = await Promise.all(files.map(async (f,i)=>({input: await sharp(dir+'/'+f).resize(W,H,{fit:'contain',background:'#fff'}).toBuffer(), left:(i%C)*W, top:Math.floor(i/C)*H})))
await sharp({create:{width:C*W,height:rows*H,channels:3,background:'#fff'}}).composite(comps).jpeg({quality:80}).toFile(out)
