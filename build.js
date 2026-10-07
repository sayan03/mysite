// Bundles the Express app into a serverless handler + copies static files (Stormkit output folders).
const esbuild=require('esbuild'),fs=require('fs');
fs.rmSync('.stormkit',{recursive:true,force:true});
esbuild.build({entryPoints:['entry.mjs'],bundle:true,platform:'node',format:'esm',target:'node20',external:['pg-native'],
  banner:{js:"import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"},outfile:'.stormkit/server/server.mjs'})
.then(()=>{fs.cpSync('public','.stormkit/public',{recursive:true});console.log('built')}).catch(()=>process.exit(1));
