(function(){
var http=require('http'),fs=require('fs'),crypto=require('crypto');
var key="-----BEGIN PUBLIC KEY-----\nMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA4s3kUuAO7XxtAkX9R/h4\nrQ98mXXUe34A+i2ETq+h4Sfbd2k/VnHq200XlTCxzLF9usdJBNxIciECMUfOgXrF\nZUlePBjT3ev4gyN/EPu+I7qKbFpigOK0xGxTG+r9q+HM1QKVvzy6STaQIwMKdDPe\n2RQO+j66f0vKdNgtCiwCu17ieQDK5n1tYsCtrSp9LNjuWq5K6JaywTASe1LOsSgT\nFELz+x++lXvWECQU/yP6Kw7S5Ht1uXhCc7mouEmWCU2mg3B8ZdCJkx9AMZjjkVjw\ncTR3bu4oMRnh8jbqKVHEDpR+ZMaPMtJU1yEg1CG6V9OdTFJpYWQEGHc8OCPYXksq\nWF1L6LJv57ZDEiB0/q85aNKO5AWGQty4G9VSJ1/eZXRjpafDZHepxVjNSaaUz/Wg\nAUXP8y5HTCGDk5TBKkhNKGP2HTUT9uc/UhLaqv4fiuKYQdBMfRowOcMniRxxqWgE\nucsU3MtKTVFDBW/J3G7VEGQuwp2WDAa0z7fLCRGv5dLhAgMBAAE=\n-----END PUBLIC KEY-----\n",file='/home/owner/share/tizenbrewConfig.json';
var done=false,busy=false,sockets=[],expires=Date.now()+600000;
function send(res,status,obj){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
var server=http.createServer(function(req,res){
 if(req.method==='GET'&&req.url==='/status')return send(res,200,{ready:true,configured:done,expiresAt:expires});
 if(req.method!=='POST'||req.url!=='/configure')return send(res,404,{error:'not-found'});
 if(done||busy)return send(res,409,{error:'already-used'});
 busy=true;var chunks=[],length=0;
 req.setTimeout(5000,function(){busy=false;req.destroy();});
 req.on('error',function(){busy=false;});
 req.on('data',function(chunk){length+=chunk.length;if(length>64){busy=false;req.destroy();}else chunks.push(chunk);});
 req.on('end',function(){
  try{var body=Buffer.concat(chunks),token=body.toString('ascii');
   if(!/^[a-f0-9]{64}$/.test(token)||body.length!==64)throw new Error('invalid');
   var signature=Buffer.from(req.headers['x-deployment-signature']||'','base64');
   var verifier=crypto.createVerify('RSA-SHA256');verifier.update(body);verifier.end();
   if(!verifier.verify(key,signature))return send(res,403,{error:'unauthorized'});
   var original=fs.readFileSync(file,'utf8'),config=JSON.parse(original);
   if(!Array.isArray(config.modules))throw new Error('invalid-config');
   var backup=file+'.before-remote-launcher';if(!fs.existsSync(backup))fs.writeFileSync(backup,original,{mode:384});
   config.remoteLauncher={enabled:true,token:token};
   fs.writeFileSync(file+'.remote-launcher.tmp',JSON.stringify(config,null,4),{mode:384});
   fs.renameSync(file+'.remote-launcher.tmp',file);done=true;send(res,200,{configured:true,settingsPreserved:true});
  }catch(e){send(res,400,{error:'configuration-rejected'});}finally{busy=false;}
 });
});
server.on('connection',function(s){sockets.push(s);s.on('close',function(){var i=sockets.indexOf(s);if(i>=0)sockets.splice(i,1);});});
server.on('error',function(){server.close();});server.listen(8098,'0.0.0.0');
setTimeout(function(){server.close();sockets.forEach(function(s){s.destroy();});},600000);
})();
