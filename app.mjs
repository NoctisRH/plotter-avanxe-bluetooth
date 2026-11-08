import {CMD, STATUS, paquete, parseGcode, validateGcode} from './protocolo.mjs';
const $=id=>document.getElementById(id);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const log=(msg)=>{const el=$('registro');el.textContent+=`\n${new Date().toLocaleTimeString()} ${msg}`;el.scrollTop=el.scrollHeight;};
const error=e=>{log('ERROR: '+(e?.message||e));console.error(e)};
const n=id=>Number($(id).value);
const value=(id,v)=>{$(id).value=String(v)};
let connected=false, enabled=false, referenced=false, contactConfirmed=false, cancelRequested=false, running=false;
let pos={x:0,y:0,z:0}; // pasos COMANDADOS desde ZERO, nunca posicion fisica medida
let cal={x:0,y:0,left:null,right:null,bottom:null,top:null};
let gcodeText='', actions=[];
function renderPos(){ $('px').textContent=referenced?(pos.x/n('sx')).toFixed(2):'sin ZERO';$('py').textContent=referenced?(pos.y/n('sy')).toFixed(2):'sin ZERO';$('pz').textContent=referenced?pos.z:'sin ZERO'; }
function renderConn(){ $('estadoTxt').textContent=connected?'Conectado al puerto seleccionado':'Desconectado';$('punto').className=connected?'ok':'';}
function config(){
 const c={sx:n('sx'),sy:n('sy'),mx:n('mx'),my:n('my'),margen:n('margen'),offset:n('offset'),contacto:n('contacto')};
 if(!Object.values(c).every(Number.isFinite)||c.sx<=0||c.sy<=0||c.mx<=0||c.my<=0||c.margen<0||c.margen>=Math.min(c.mx,c.my)/2||c.offset<0||c.contacto<1||c.contacto>600)throw new Error('Configuracion invalida (revisa mm, limites y contacto)');
 return c;
}
function saveSettings(){const c=config();localStorage.setItem('plotter_av_bt_settings_v1',JSON.stringify(c));log('Calibracion y margen guardados en este navegador.');renderPos();drawPreview();}
function restoreSettings(){try{const c=JSON.parse(localStorage.getItem('plotter_av_bt_settings_v1')||'null');if(c)for(const [k,v] of Object.entries(c))if($(k))value(k,v)}catch(e){error(e)}}

class SerialLink {
 constructor(){this.port=null;this.reader=null;this.writer=null;this.pending=null;this.tail=Promise.resolve();this.loop=null;this.expectStatus=false;}
 async open(){
  if(!('serial' in navigator))throw Error('Este Chrome no tiene Web Serial. En Android usa Chrome actualizado (138+) y en PC Chrome moderno.');
  // El selector nativo muestra puertos serie, incluidos HC-05 emparejados mediante Bluetooth SPP.
  this.port=await navigator.serial.requestPort();
  await this.port.open({baudRate:n('baudios'),bufferSize:4096});
  this.writer=this.port.writable.getWriter();
  this.loop=this.readLoop();connected=true;renderConn();log(`Puerto abierto a ${n('baudios')} bps; ajusta S3 segun USB/Bluetooth.`);
 }
 async readLoop(){
  try{
   this.reader=this.port.readable.getReader();
   while(true){
    const {value,done}=await this.reader.read();if(done)break;
    for(const b of value){
     if(!this.expectStatus){if(b===0x5A)this.expectStatus=true;continue}
     this.expectStatus=false;
     const p=this.pending;
     if(p){this.pending=null;clearTimeout(p.timer);if(b===0||p.allowE2&&b===0xE2)p.resolve(b);
       else p.reject(Error(`FPGA 0x${b.toString(16).toUpperCase()}: ${STATUS[b]||'respuesta desconocida'}`));}
     else log(`Respuesta sin orden pendiente: 5A ${b.toString(16).padStart(2,'0')}`);
    }
   }
  }catch(e){if(connected)error(e)}finally{
   if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('Puerto cerrado durante una orden'));this.pending=null;}
   try{this.reader?.releaseLock()}catch{}
   this.reader=null;connected=false;enabled=false;referenced=false;contactConfirmed=false;renderConn();renderPos();
  }
 }
 async close(){
  if(!this.port)return;
  if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('Desconectado'));this.pending=null}
  try{await this.reader?.cancel()}catch{}
  try{await this.loop}catch{}
  try{this.writer?.releaseLock()}catch{}
  try{await this.port.close()}catch(e){error(e)}
  this.port=null;this.writer=null;connected=false;enabled=false;referenced=false;contactConfirmed=false;renderConn();renderPos();
  log('Puerto desconectado. Referencia invalida hasta nuevo ZERO.');
 }
 request(cmd,x=0,y=0,z=0,rate=1,{allowE2=false}={}){
  const packet=paquete(cmd,x,y,z,rate);
  const execute=()=>{
   if(!connected||!this.writer)throw Error('Conecta primero el HC-05');
   // La frecuencia minima del VHDL es 80 pasos/s; el timeout se adapta al recorrido.
   const ms=Math.max(4500,Math.ceil(Math.max(Math.abs(x),Math.abs(y),Math.abs(z))/80*1000+10000));
   return new Promise((resolve,reject)=>{
    const p={resolve,reject,allowE2,timer:0};
    p.timer=setTimeout(()=>{
      if(this.pending===p)this.pending=null;
      connected=false;referenced=false;contactConfirmed=false;renderConn();renderPos();
      reject(Error('Timeout UART; desincronizacion posible. Desconecta y vuelve a referenciar.'));
    },ms);
    this.pending=p;
    this.writer.write(packet).catch(e=>{if(this.pending===p)this.pending=null;clearTimeout(p.timer);reject(e)});
   });
  };
  const job=this.tail.then(execute,execute);
  this.tail=job.catch(()=>{});
  return job;
 }
 async stopNow(){
  cancelRequested=true;
  if(!connected||!this.writer)return;
  // STOP fuera de la cola de solicitudes. C3 responde E5 si interrumpe RUN.
  await this.writer.write(paquete(CMD.STOP,0,0,0,0));
  referenced=false;contactConfirmed=false;renderPos();
  log('STOP enviado directamente. Verifica mecanismo y vuelve a establecer ZERO.');
 }
}
const link=new SerialLink();
async function cmd(c,x=0,y=0,z=0){const code=await link.request(c,x,y,z,n('nivel'),{allowE2:c===CMD.STATUS});if(c===CMD.STATUS)log(`STATUS: ${STATUS[code]||code}`);return code}
async function jogPhysical(dx,dy,dz,calibration=false){
 if(!enabled)throw Error('Primero HABILITAR');
 if(!calibration&&!referenced)throw Error('Para movimiento normal establece ZERO despues de alinear las marcas');
 if(calibration&&referenced)throw Error('Calibracion manual solo ANTES de ZERO. Reinicia la referencia de manera controlada.');
 const c=config();
 if(!calibration){
  const nx=pos.x+dx,ny=pos.y+dy,nz=pos.z+dz;
  if(nx<0||ny<0||nz<0||nx>Math.round(c.mx*c.sx)||ny>Math.round(c.my*c.sy)||nz>600)throw Error('Movimiento excede limites configurados (mecanicos/Z)');
 }
 await cmd(calibration?CMD.CAL_JOG:CMD.MOVE,dx,dy,dz);
 if(calibration){cal.x+=dx;cal.y+=dy;renderCal();}
 else{pos.x+=dx;pos.y+=dy;pos.z+=dz;renderPos()}
 log(`${calibration?'CAL_JOG':'MOVE'} X${dx>=0?'+':''}${dx} Y${dy>=0?'+':''}${dy} Z${dz>=0?'+':''}${dz}`);
}
function renderCal(){ $('calEstado').textContent=`Pasos relativos de calibracion: X ${cal.x}, Y ${cal.y} · Izq:${cal.left??'—'} Der:${cal.right??'—'} Abajo:${cal.bottom??'—'} Arriba:${cal.top??'—'}`; }
async function moveTo(x,y){
 const c=config(),targetX=Math.round(x*c.sx),targetY=Math.round(y*c.sy),dx=targetX-pos.x,dy=targetY-pos.y;
 if(dx||dy)await jogPhysical(dx,dy,0,false);
}
async function setPen(down){
 if(!referenced)throw Error('Primero establece ZERO XYZ');
 if(down&&!contactConfirmed)throw Error('Verifica la altura y pulsa Guardar contacto Z EN ESTA SESION antes de bajar el plumon');
 const target=down?n('contacto'):0;
 if(target!==pos.z){await jogPhysical(0,0,target-pos.z,false);await wait(170)}
}
async function jobSafe(fn){try{await fn()}catch(e){error(e)}}
const attach=(id,fn)=>$(id).addEventListener('click',()=>jobSafe(fn));
attach('conectar',async()=>{await link.open()});
attach('desconectar',async()=>{if(running)throw Error('Deten el movimiento antes de desconectar');await link.close()});
attach('status',async()=>{await cmd(CMD.STATUS)});
attach('enable',async()=>{await cmd(CMD.ENABLE);enabled=true;log('Motores habilitados')});
attach('disable',async()=>{if(running)throw Error('Deten el dibujo primero');await cmd(CMD.DISABLE);enabled=false;referenced=false;contactConfirmed=false;renderPos();log('Motores deshabilitados; se pierde referencia');});
attach('zero',async()=>{if(!enabled)throw Error('Primero HABILITAR');if(running)throw Error('No hagas ZERO durante un dibujo');if(!confirm('Confirma: X/Y estan en las marcas fisicas (0,0), Z elevado y no hay movimiento. ¿Establecer ZERO XYZ?'))return;await cmd(CMD.ZERO);referenced=true;pos={x:0,y:0,z:0};contactConfirmed=false;renderPos();log('ZERO XYZ confirmado. Contacto Z requiere nueva verificacion');});
attach('stop',async()=>{await link.stopNow()});attach('cancelar',async()=>{await link.stopNow()});
for(const [id,dx,dy] of [['xp',1,0],['xm',-1,0],['yp',0,1],['ym',0,-1]])attach(id,async()=>{const c=config(),d=n('pasomm');await jogPhysical(Math.round(dx*d*c.sx),Math.round(dy*d*c.sy),0)});
for(const [id,d] of [['zp',1],['zm',-1]])attach(id,async()=>{await jogPhysical(0,0,d*n('pasoz'))});
attach('guardarZ',async()=>{if(!referenced||pos.z<=0)throw Error('Primero ZERO, luego baja Z hasta contacto positivo');value('contacto',pos.z);contactConfirmed=true;saveSettings();log(`Contacto Z guardado: ${pos.z} medios pasos (solo confiable en esta sesion)`);});
attach('plumaUp',async()=>{await setPen(false)});attach('plumaDown',async()=>{await setPen(true)});
attach('guardarAjustes',async()=>{saveSettings()});
for(const [id,dx,dy] of [['cxp',1,0],['cxm',-1,0],['cyp',0,1],['cym',0,-1]])attach(id,async()=>{const s=n('calStep');await jogPhysical(dx*s,dy*s,0,true)});
for(const [id,key] of [['left','left'],['right','right'],['bottom','bottom'],['top','top']])attach(id,async()=>{if(referenced)throw Error('Marca extremos ANTES de ZERO');if(!enabled)throw Error('Primero HABILITAR');cal[key]=(key==='left'||key==='right')?cal.x:cal.y;renderCal();log(`Extremo ${key} registrado en ${cal[key]} medios pasos acumulados`)});
attach('calcXY',async()=>{
 if(cal.left===null||cal.right===null||cal.bottom===null||cal.top===null)throw Error('Marca los cuatro extremos primero');
 if(cal.right<=cal.left||cal.top<=cal.bottom)throw Error('Direccion invalida: X+ debe ir derecha, Y+ arriba');
 const c=config();const sx=(cal.right-cal.left)/c.mx,sy=(cal.top-cal.bottom)/c.my;
 if(sx<=0||sy<=0)throw Error('Medicion invalida');value('sx',sx.toFixed(5));value('sy',sy.toFixed(5));saveSettings();log(`Calibracion: X=${sx.toFixed(4)} Y=${sy.toFixed(4)} medios pasos/mm`);
});
attach('volverCal',async()=>{
 if(referenced)throw Error('El retorno de calibracion se usa ANTES de ZERO');if(cal.left===null||cal.bottom===null)throw Error('Marca primero X izquierda e Y abajo');
 const dx=cal.left-cal.x,dy=cal.bottom-cal.y;
 if(!confirm(`Regresar XY simultaneos (${dx}, ${dy}) medios pasos por conteo. Vigila los topes. ¿Continuar?`))return;
 // Calibracion en paquetes, ambos ejes coordinados. Para distancias largas se generan bloques DDA proporcionales.
 let remX=dx,remY=dy;const total=Math.max(Math.abs(dx),Math.abs(dy));let done=0;
 while(done<total){const next=Math.min(total,done+3000);const ax=Math.round(dx*next/total)-Math.round(dx*done/total);const ay=Math.round(dy*next/total)-Math.round(dy*done/total);
   await jogPhysical(ax,ay,0,true);done=next;
 }
 log('Regreso estimado completo. Comprueba marcas fisicas ANTES de pulsar ZERO XYZ.');
});

const canvas=$('visor'),ctx=canvas.getContext('2d');
function drawPreview(){
 const w=canvas.width,h=canvas.height,margin=38;ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
 ctx.strokeStyle='#cbd8e7';ctx.lineWidth=2;ctx.strokeRect(margin,margin,w-2*margin,h-2*margin);
 const c=config();const scale=(w-2*margin)/Math.max(c.mx,c.my),fx=x=>margin+x*scale,fy=y=>h-margin-y*scale;
 const drawBounds=Math.min(c.mx,c.my)-c.margen*2;
 ctx.strokeStyle='#b6e0f7';ctx.setLineDash([7,5]);ctx.strokeRect(fx(c.margen),fy(c.my-c.margen),drawBounds*scale,drawBounds*scale);ctx.setLineDash([]);
 let x=0,y=0,down=false;for(const a of actions){if(a.kind==='pen'){down=a.down;continue};let xx=a.x+c.offset,yy=a.y+c.offset;
 ctx.beginPath();ctx.moveTo(fx(x),fy(y));ctx.lineTo(fx(xx),fy(yy));ctx.lineWidth=down&&!a.rapid?1.5:0.7;ctx.strokeStyle=down&&!a.rapid?'#176cb3':'#e8b18f';if(down&&!a.rapid)ctx.setLineDash([]);else ctx.setLineDash([3,5]);ctx.stroke();ctx.setLineDash([]);x=xx;y=yy;}
 ctx.fillStyle='#476785';ctx.font='16px system-ui';ctx.fillText('(0,0)',margin+4,h-margin-7);
}
function parseCurrent(){actions=parseGcode(gcodeText);$('cuenta').textContent=`${actions.filter(x=>x.kind==='move').length} segmentos`;drawPreview();}
$('archivo').addEventListener('change',async e=>{try{const f=e.target.files?.[0];if(!f)return;gcodeText=await f.text();parseCurrent();log(`${f.name}: ${actions.length} instrucciones importadas.`)}catch(e){error(e)}});
attach('simular',async()=>{if(!actions.length)throw Error('Abre o genera un G-code');const c=config();validateGcode(actions,{offset:c.offset,mechanicalX:c.mx,mechanicalY:c.my,margin:c.margen});drawPreview();log(`G-code verificado: ${actions.length} instrucciones, area segura ${c.mx-2*c.margen} x ${c.my-2*c.margen} mm`);});
function sampleShape(circle=false){const seg=circle?80:4,pts=[];const cx=25,cy=25,r=10;for(let i=0;i<=seg;i++){
 let x,y;if(circle){const a=i/seg*Math.PI*2;x=cx+r*Math.cos(a);y=cy+r*Math.sin(a)}else{const corners=[[15,15],[35,15],[35,35],[15,35],[15,15]];[x,y]=corners[i]};pts.push([x,y]);}
 gcodeText='; Prueba de trazos generada para HC-05\nG21\nG90\nM5\nG0 X'+pts[0][0].toFixed(3)+' Y'+pts[0][1].toFixed(3)+'\nM3\n'+pts.slice(1).map(p=>`G1 X${p[0].toFixed(3)} Y${p[1].toFixed(3)}`).join('\n')+'\nM5\n';parseCurrent();log(`Figura de prueba ${circle?'circulo':'cuadrado'} generada; primero Verificar archivo.`);
}
attach('testCuadro',async()=>sampleShape(false));attach('testCirculo',async()=>sampleShape(true));
attach('guardarGcode',async()=>{if(!gcodeText)throw Error('Primero genera o abre un archivo');const a=document.createElement('a'),b=new Blob([gcodeText],{type:'text/plain'});a.href=URL.createObjectURL(b);a.download='plotter_hc05.gcode';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)});
attach('dibujar',async()=>{
 if(running)throw Error('Ya hay un dibujo ejecutandose');if(!connected||!enabled||!referenced)throw Error('Conecta, habilita y establece ZERO antes de dibujar');if(!contactConfirmed)throw Error('Verifica y guarda CONTACTO Z en esta sesion');if(!actions.length)throw Error('Carga G-code primero');
 const c=config();validateGcode(actions,{offset:c.offset,mechanicalX:c.mx,mechanicalY:c.my,margin:c.margen});
 if(!confirm(`Ejecutar ${actions.filter(a=>a.kind==='move').length} movimientos reales con contacto Z=${c.contacto}? Aleja manos y vigila topes.`))return;
 running=true;cancelRequested=false;let count=0;let down=false;
 try{
  await setPen(false);
  for(const a of actions){if(cancelRequested)break;
   if(a.kind==='pen'){down=a.down;await setPen(down);continue}
   if(a.rapid)await setPen(false);
   await moveTo(a.x+c.offset,a.y+c.offset);
   count++;if(count%25===0)log(`Dibujo: ${count} movimientos completados`);
  }
  if(!cancelRequested){await setPen(false);await moveTo(0,0);log(`Dibujo completado: ${count} segmentos, regreso (0,0) por conteo`)}
  else log(`Dibujo detenido tras ${count} segmentos; referencia requiere ZERO`);
 }catch(e){error(e);referenced=false;contactConfirmed=false;log('Revisa la posicion fisica y vuelve a ZERO.');}
 finally{running=false;renderPos()}
});
restoreSettings();renderPos();renderConn();renderCal();drawPreview();
const secure=window.isSecureContext;const support=('serial' in navigator);
$('compat').textContent=secure&&support?'Web Serial disponible. Si no aparece el HC-05, vincula primero el modulo en Bluetooth del sistema.':(!secure?'La pagina necesita HTTPS o http://localhost para acceder a los puertos.':'Este navegador no tiene Web Serial; usa Chrome actualizado (Android 138+ o PC).');
window.addEventListener('beforeunload',e=>{if(running){e.preventDefault();e.returnValue='Hay un dibujo en curso'}});
