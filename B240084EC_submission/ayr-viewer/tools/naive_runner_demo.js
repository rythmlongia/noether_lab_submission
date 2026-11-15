// Demonstrates the two bugs of the "obvious" runner: spawn without -u, and child.kill().
const {spawn,execSync}=require('child_process');
const solver=process.argv[2], cas=process.argv[3];
const env={...process.env}; delete env.PYTHONUNBUFFERED;
const c=spawn('python3',[solver,'--case',cas],{env});
let first=null;const t0=Date.now();
c.stdout.on('data',d=>{if(first===null&&/PROGRESS [1-9]/.test(d)){first=Date.now()-t0;}});
setTimeout(()=>{console.log('naive spawn (no -u, PYTHONUNBUFFERED unset): first PROGRESS > 0 received after', first===null?'NOTHING within 3 s':first+' ms');
c.kill(); console.log('naive cancel = child.kill() (SIGTERM to the controller only). 1 s later, ps shows:');
setTimeout(()=>{console.log(execSync("ps -eo pid,stat,args | grep fake_solver | grep -v grep || true").toString());execSync("pkill -f fake_solver.py || true");process.exit()},1000)},3000);
