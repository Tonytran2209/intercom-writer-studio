import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import path from 'node:path';
const root=process.cwd();
// Real component and CSS, deterministic fixture, no production API/auth/AI credentials.
const server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:4173,strictPort:true},plugins:[
  {name:'isolated-browser-fixture',enforce:'pre',transform(_,id){if(id===path.join(root,'src/main.tsx'))return `import '../tests/agent-lab/fixture.jsx';`;}},react(),tailwind(),
]});await server.listen();
