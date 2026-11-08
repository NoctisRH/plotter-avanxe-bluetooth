// Paquetes binarios para FPGA AVANXE: A5 CMD XH XL YH YL ZH ZL RATE XOR.
export const CMD = Object.freeze({MOVE:1,ZERO:2,ENABLE:3,DISABLE:4,STOP:5,STATUS:6,CAL_JOG:7});
export const STATUS = Object.freeze({0:'Listo',0xE0:'Comando desconocido',0xE1:'Checksum incorrecto',0xE2:'Sin referencia o motor inhabilitado',0xE3:'No se permite Z junto con XY',0xE4:'Fuera de limites logicos',0xE5:'Movimiento interrumpido'});
export function paquete(cmd,x=0,y=0,z=0,rate=1){
  for(const [n,v] of Object.entries({x,y,z})) if(!Number.isInteger(v)||v < -32768||v > 32767) throw new Error(`${n} fuera de signed16`);
  if(!Number.isInteger(cmd)||cmd<1||cmd>7||!Number.isInteger(rate)||rate<0||rate>4) throw new Error('Comando o velocidad invalidos');
  const a=new Uint8Array(10),v=new DataView(a.buffer);
  a[0]=0xA5;a[1]=cmd;v.setInt16(2,x,false);v.setInt16(4,y,false);v.setInt16(6,z,false);a[8]=rate;
  for(let i=0;i<9;i++)a[9]^=a[i];
  return a;
}
// G-code simplificado compatible con el exportador Python: G21/G90, G0/G1, M3/M5.
// Se rechazan arcos o unidades distintas para no dibujar trayectorias inesperadas.
export function parseGcode(text){
 const actions=[]; let x=0,y=0,absolute=true,mode='G0',units=1;
 const lines=text.split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  let line=lines[i].replace(/\([^)]*\)/g,'').split(';')[0].trim().toUpperCase();
  if(!line||line.startsWith('%'))continue;
  const tokens=[...line.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)];
  if(!tokens.length)continue;
  const lineNos=tokens.filter(t=>t[1]==='G').map(t=>Number(t[2]));
  const mNos=tokens.filter(t=>t[1]==='M').map(t=>Number(t[2]));
  for(const g of lineNos){
   if(g===21) units=1;
   else if(g===20)throw new Error(`Linea ${i+1}: pulgadas G20 no soportadas; usa G21`);
   else if(g===90)absolute=true;
   else if(g===91)absolute=false;
   else if(g===0||g===1)mode=`G${g}`;
   else throw new Error(`Linea ${i+1}: G${g} no soportado (solo G0/G1/G21/G90/G91)`);
  }
  for(const m of mNos){
   if(m===3||m===5)actions.push({kind:'pen',down:m===3,line:i+1});
   else if(m===2||m===30)continue;
   else throw new Error(`Linea ${i+1}: M${m} no soportado`);
  }
  const coords=Object.fromEntries(tokens.filter(t=>t[1]==='X'||t[1]==='Y').map(t=>[t[1],Number(t[2]) * units]));
  if(Object.keys(coords).length){
   const nx=coords.X===undefined?x:(absolute?coords.X:x+coords.X);
   const ny=coords.Y===undefined?y:(absolute?coords.Y:y+coords.Y);
   if(!Number.isFinite(nx)||!Number.isFinite(ny))throw new Error(`Linea ${i+1}: coordenadas invalidas`);
   x=nx;y=ny;actions.push({kind:'move',rapid:mode==='G0',x,y,line:i+1});
  }
  if(tokens.some(t=>t[1]==='Z'))throw new Error(`Linea ${i+1}: Z por G-code no soportado; usa M3/M5 (Z angular)`);
 }
 if(actions.length>30000)throw new Error('Demasiados segmentos (>30000)');
 return actions;
}
export function validateGcode(actions,{offset=5,mechanicalX=98,mechanicalY=98,margin=5}={}){
 if(!(Number.isFinite(offset)&&Number.isFinite(mechanicalX)&&Number.isFinite(mechanicalY)&&Number.isFinite(margin)))throw new Error('Configuracion invalida');
 for(const a of actions)if(a.kind==='move'){
   const tx=a.x+offset,ty=a.y+offset;
   if(tx<margin-1e-6||ty<margin-1e-6||tx>mechanicalX-margin+1e-6||ty>mechanicalY-margin+1e-6)
    throw new Error(`Linea ${a.line}: destino (${tx.toFixed(2)},${ty.toFixed(2)}) mm fuera del area segura`);
 }
 return true;
}
