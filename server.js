require('dotenv').config();
const express=require('express'),helmet=require('helmet'),rate=require('express-rate-limit'),crypto=require('crypto');
const {Pool}=require('pg'),Razorpay=require('razorpay'),nodemailer=require('nodemailer'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs'),cookie=require('cookie-parser');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:1});
const q=(s,p=[])=>pool.query(s,p).then(r=>r.rows),q1=(s,p)=>q(s,p).then(r=>r[0]);
const rzp=new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
const mail=nodemailer.createTransport({host:process.env.SMTP_HOST,port:+process.env.SMTP_PORT||587,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
const S=async k=>(await q1('SELECT v FROM settings WHERE k=$1',[k]))?.v;
const wrap=f=>(req,res,next)=>Promise.resolve(f(req,res,next)).catch(e=>{console.error(e);res.status(500).json({error:'সার্ভার ত্রুটি'})});
const app=express();app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","https://checkout.razorpay.com","'unsafe-inline'"],frameSrc:["https://api.razorpay.com"],imgSrc:["'self'","data:","https:"],styleSrc:["'self'","'unsafe-inline'"],connectSrc:["'self'","https://lumberjack.razorpay.com"]}}}));
app.post('/api/webhook',express.raw({type:'*/*'}),wrap(async(req,res)=>{ // raw body BEFORE json parser
  const sig=req.headers['x-razorpay-signature'],body=Buffer.isBuffer(req.body)?req.body:Buffer.from(JSON.stringify(req.body));
  const exp=crypto.createHmac('sha256',process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  if(!sig||sig.length!==exp.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(exp)))return res.sendStatus(400);
  const ev=JSON.parse(body),p=ev.payload?.payment?.entity;
  if(p&&(ev.event==='payment.captured'||ev.event==='order.paid'))await fulfil(p.order_id,p.id);
  if(p&&ev.event==='payment.failed')await q("UPDATE orders SET payment_status='failed' WHERE razorpay_order_id=$1 AND payment_status='created'",[p.order_id]);
  res.sendStatus(200)}));
app.use(express.json({limit:'50kb'}),cookie());app.use(rate({windowMs:60000,max:120}));
const price=p=>p.discount_price||p.price;
async function coupon(code,total){if(!code)return{off:0};const c=await q1('SELECT * FROM coupons WHERE code=$1 AND is_active=1',[code.toUpperCase()]);
  if(!c||(c.expires_at&&+c.expires_at<Date.now())||(c.usage_limit&&c.used>=c.usage_limit))return{err:'কুপন বৈধ নয়'};
  return{c,off:Math.min(total,Math.floor(total*c.percent/100)+c.fixed)}}
app.get('/api/products',wrap(async(a,r)=>r.json(await q('SELECT id,title,slug,description,category,language,price,discount_price,cover_image,page_count,is_bundle FROM products WHERE is_active=1 ORDER BY id'))));
app.get('/api/settings',wrap(async(a,r)=>r.json({brand:await S('brand'),support_email:await S('support_email')})));
app.post('/api/checkout',wrap(async(req,res)=>{
  const{name,email,ids,coupon:code}=req.body;
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email||'')||!name||!Array.isArray(ids)||!ids.length||ids.length>30)return res.status(400).json({error:'তথ্য সঠিক নয়'});
  const ps=await q('SELECT * FROM products WHERE id=ANY($1::int[]) AND is_active=1',[ids.map(Number)]);
  if(!ps.length)return res.status(400).json({error:'পণ্য পাওয়া যায়নি'});
  const total=ps.reduce((s,p)=>s+price(p),0),cp=await coupon(code,total);if(cp.err)return res.status(400).json({error:cp.err});
  const amount=total-cp.off;if(amount<1)return res.status(400).json({error:'অবৈধ পরিমাণ'});
  const id='ORD-'+crypto.randomBytes(5).toString('hex').toUpperCase();
  const ro=await rzp.orders.create({amount:amount*100,currency:'INR',receipt:id});
  await q('INSERT INTO orders(id,customer_name,customer_email,amount,coupon,razorpay_order_id) VALUES($1,$2,$3,$4,$5,$6)',[id,name.slice(0,100),email.toLowerCase(),amount,cp.c?.code||null,ro.id]);
  for(const p of ps)await q('INSERT INTO order_items VALUES($1,$2)',[id,p.id]);
  res.json({orderId:id,razorpayOrderId:ro.id,amount:amount*100,key:process.env.RAZORPAY_KEY_ID})}));
async function fulfil(rzpOrderId,paymentId){ // only after signature/webhook verification; idempotent
  const o=await q1('SELECT * FROM orders WHERE razorpay_order_id=$1',[rzpOrderId]);if(!o)throw new Error('no order');if(o.payment_status==='paid')return o;
  const pay=await rzp.payments.fetch(paymentId);
  if(pay.order_id!==rzpOrderId||pay.amount!==o.amount*100||!['captured','authorized'].includes(pay.status))throw new Error('payment mismatch');
  if(pay.status==='authorized')await rzp.payments.capture(paymentId,pay.amount,'INR');
  const c=await pool.connect();let won=false;
  try{await c.query('BEGIN');
    won=(await c.query("UPDATE orders SET payment_status='paid',payment_id=$1 WHERE id=$2 AND payment_status<>'paid' RETURNING id",[paymentId,o.id])).rowCount>0;
    if(won){if(o.coupon)await c.query('UPDATE coupons SET used=used+1 WHERE code=$1',[o.coupon]);
      const exp=Date.now()+(+(await S('download_expiry_hours'))||48)*3600e3;
      const prods=(await c.query('SELECT DISTINCT p.id FROM order_items i JOIN products p ON (p.id=i.product_id AND p.is_bundle=0) OR (p.is_bundle=0 AND p.is_active=1 AND EXISTS(SELECT 1 FROM products b WHERE b.id=i.product_id AND b.is_bundle=1)) WHERE i.order_id=$1',[o.id])).rows;
      for(const p of prods)await c.query('INSERT INTO downloads(order_id,product_id,download_token,expires_at) VALUES($1,$2,$3,$4)',[o.id,p.id,crypto.randomBytes(32).toString('hex'),exp])}
    await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  if(won){const links=await q('SELECT d.download_token t,p.title FROM downloads d JOIN products p ON p.id=d.product_id WHERE order_id=$1',[o.id]);
    try{await mail.sendMail({from:process.env.SMTP_USER,to:o.customer_email,subject:'আপনার Trading PDF Order সফল হয়েছে',
      text:`নমস্কার ${o.customer_name},\n\nআপনার পেমেন্ট সফল হয়েছে।\nOrder ID: ${o.id}\n\nআপনার কেনা PDF:\n${links.map(l=>`- ${l.title}: ${process.env.BASE_URL}/api/download/${l.t}`).join('\n')}\n\nধন্যবাদ,\n${await S('brand')}`})}catch(e){console.error('mail',e)}}
  return o}
app.post('/api/verify',wrap(async(req,res)=>{const{razorpay_order_id:o,razorpay_payment_id:p,razorpay_signature:s}=req.body;
  const exp=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(o+'|'+p).digest('hex');
  if(!s||s.length!==exp.length||!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(exp)))return res.status(400).json({ok:false});
  try{const ord=await fulfil(o,p);res.json({ok:true,orderId:ord.id,token:jwt.sign({o:ord.id},process.env.JWT_SECRET,{expiresIn:'1h'})})}catch(e){console.error(e);res.status(400).json({ok:false})}}));
app.get('/api/order/:id',wrap(async(req,res)=>{try{if(jwt.verify(req.query.t,process.env.JWT_SECRET).o!==req.params.id)throw 0}catch{return res.sendStatus(403)}
  const o=await q1("SELECT id,customer_name,customer_email,amount FROM orders WHERE id=$1 AND payment_status='paid'",[req.params.id]);if(!o)return res.sendStatus(404);
  o.items=await q('SELECT p.title,d.download_token token FROM downloads d JOIN products p ON p.id=d.product_id WHERE d.order_id=$1',[o.id]);res.json(o)}));
app.get('/api/download/:token',wrap(async(req,res)=>{
  const d=await q1(`SELECT d.*,p.file_path FROM downloads d JOIN products p ON p.id=d.product_id JOIN orders o ON o.id=d.order_id WHERE d.download_token=$1 AND o.payment_status='paid'`,[req.params.token]);
  if(!d||!d.file_path)return res.status(404).send('Invalid link');
  if(+d.expires_at<Date.now())return res.status(410).send('লিংকের মেয়াদ শেষ। সহায়তার জন্য যোগাযোগ করুন।');
  const upd=await q1('UPDATE downloads SET download_count=download_count+1 WHERE id=$1 AND download_count<$2 RETURNING id',[d.id,+(await S('max_downloads'))||3]);
  if(!upd)return res.status(429).send('ডাউনলোডের সীমা শেষ।');
  const sb=process.env.SUPABASE_URL+'/storage/v1',h={apikey:process.env.SUPABASE_SERVICE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_KEY,'Content-Type':'application/json'};
  const r=await fetch(`${sb}/object/sign/pdfs/${encodeURI(d.file_path)}`,{method:'POST',headers:h,body:JSON.stringify({expiresIn:60})});
  if(!r.ok)return res.status(404).send('File missing');res.redirect(302,sb+(await r.json()).signedURL)})); // 60-second signed URL from a PRIVATE bucket
app.post('/api/admin/login',rate({windowMs:900000,max:10}),(req,res)=>{const{email,password}=req.body;
  if(email!==process.env.ADMIN_EMAIL||!bcrypt.compareSync(password||'',process.env.ADMIN_PASSWORD_HASH||''))return res.sendStatus(401);
  res.cookie('adm',jwt.sign({a:1},process.env.JWT_SECRET,{expiresIn:'8h'}),{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'}).sendStatus(200)});
const adm=(req,res,next)=>{try{jwt.verify(req.cookies.adm,process.env.JWT_SECRET);next()}catch{res.sendStatus(401)}};
app.get('/api/admin/stats',adm,wrap(async(q_,r)=>r.json({
  stats:await q1("SELECT COUNT(*)::int orders,(COUNT(*) FILTER(WHERE payment_status='paid'))::int paid,(COUNT(*) FILTER(WHERE payment_status='failed'))::int failed,COALESCE(SUM(amount) FILTER(WHERE payment_status='paid'),0)::int revenue FROM orders"),
  top:await q1("SELECT p.title,COUNT(*) n FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products p ON p.id=i.product_id WHERE o.payment_status='paid' GROUP BY p.id ORDER BY n DESC LIMIT 1"),
  orders:await q('SELECT o.*,(SELECT SUM(download_count) FROM downloads WHERE order_id=o.id) dl FROM orders o ORDER BY created_at DESC LIMIT 200'),
  products:await q('SELECT * FROM products ORDER BY id'),coupons:await q('SELECT * FROM coupons'),settings:await q('SELECT * FROM settings')})));
app.post('/api/admin/product',adm,wrap(async(req,res)=>{const b=req.body,n=x=>x===''||x==null?null:+x;
  const v=[b.title,b.slug,b.description,b.category,b.language,n(b.price)||0,n(b.discount_price),n(b.page_count),b.is_active==='0'?0:1,b.is_bundle==='1'?1:0,b.file_path||null,b.cover_image||null];
  if(b.id)await q('UPDATE products SET title=$1,slug=$2,description=$3,category=$4,language=$5,price=$6,discount_price=$7,page_count=$8,is_active=$9,is_bundle=$10,file_path=$11,cover_image=$12 WHERE id=$13',[...v,+b.id]);
  else await q('INSERT INTO products(title,slug,description,category,language,price,discount_price,page_count,is_active,is_bundle,file_path,cover_image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',v);res.sendStatus(200)}));
app.delete('/api/admin/product/:id',adm,wrap(async(req,res)=>{await q('DELETE FROM products WHERE id=$1',[+req.params.id]);res.sendStatus(200)}));
app.post('/api/admin/coupon',adm,wrap(async(req,res)=>{const c=req.body;await q('INSERT INTO coupons(code,percent,fixed,expires_at,usage_limit) VALUES($1,$2,$3,$4,$5) ON CONFLICT(code) DO UPDATE SET percent=$2,fixed=$3,expires_at=$4,usage_limit=$5',[c.code.toUpperCase(),+c.percent||0,+c.fixed||0,c.expires_at?Date.parse(c.expires_at):null,+c.usage_limit||null]);res.sendStatus(200)}));
app.post('/api/admin/settings',adm,wrap(async(req,res)=>{for(const[k,v]of Object.entries(req.body))if(v!=='')await q('INSERT INTO settings VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=$2',[k,String(v)]);res.sendStatus(200)}));
app.get('/admin',(q_,r)=>r.redirect('/admin.html'));
module.exports=app;
if(require.main===module){app.use(express.static('public'));app.listen(process.env.PORT||3000,()=>console.log('running'))}
