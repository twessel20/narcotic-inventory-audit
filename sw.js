const CACHE='narcotic-audit-v241';
const ASSETS=['./','./index.html','./styles.css?v=20261018-241','./app.js?v=20261018-241','./manifest.webmanifest','./gfd-patch.jpg','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png','./icons/apple-touch-icon.png','./icons/apple-touch-icon-v226.png','./apple-touch-icon.png','./apple-touch-icon-v226.png','./apple-touch-icon-precomposed.png','./icons/favicon-48.png'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))])));
// Cache-first for versioned app assets; iPhone should not download large
// report/PDF bundles on every launch. Navigation remains network-first so
// a new GitHub Pages deployment is still detected promptly.
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET')return;
 const url=new URL(request.url);
 const sameOrigin=url.origin===self.location.origin;
 const isExternalScript=!sameOrigin&&request.destination==='script';
 if(!sameOrigin&&!isExternalScript)return;
 const isAsset=isExternalScript||(/\.(?:js|css|png|jpe?g|svg|webp|webmanifest)$/i.test(url.pathname)&&!url.pathname.endsWith('/sw.js'));
 if(isAsset){
   event.respondWith(caches.match(request).then(cached=>{
     // Serve installed code immediately; external SDKs refresh in the background.
     if(cached){
       if(isExternalScript)event.waitUntil(fetch(request).then(response=>{
         if(!response.ok)return;
         return caches.open(CACHE).then(cache=>cache.put(request,response.clone()));
       }).catch(()=>{}));
       return cached;
     }
     return fetch(request).then(response=>{
       if(response.ok)event.waitUntil(caches.open(CACHE).then(cache=>cache.put(request,response.clone())).catch(()=>{}));
       return response;
     });
   }));
   return;
 }
 event.respondWith(fetch(request,{cache:'no-cache'}).then(response=>{
   if(response.ok)event.waitUntil(caches.open(CACHE).then(cache=>cache.put(request,response.clone())).catch(()=>{}));
   return response;
 }).catch(async()=>await caches.match(request)||await caches.match('./index.html')));
});
self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting()});
