import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/agent-lab',testMatch:'*.spec.mjs',workers:1,retries:process.env.CI?1:0,globalTimeout:600000,reporter:[['list'],['html',{open:'never'}]],
 use:{baseURL:'http://127.0.0.1:4173',browserName:'chromium',trace:'retain-on-failure',screenshot:'on',video:'retain-on-failure'},
 projects:[{name:'desktop',use:{viewport:{width:1280,height:900}}},{name:'mobile',use:{viewport:{width:390,height:844}}}],
 webServer:{command:'node tests/agent-lab/server.mjs',url:'http://127.0.0.1:4173',reuseExistingServer:false,timeout:60000}});
