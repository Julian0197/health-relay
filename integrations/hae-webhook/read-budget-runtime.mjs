// Synthetic SQL billing regression; no production data or outbound requests.
// node integrations/hae-webhook/read-budget-runtime.mjs <bundled-miniflare-path>
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(process.argv[2]).href);
const script = `
import { SeriesStore } from './series.mjs';
import { SqlUsage } from './sql-usage.mjs';
export class Probe {
  constructor(ctx) { this.storage=ctx.storage; }
  fetch() {
    const meter=new SqlUsage(this.storage.sql), sql=meter.sql;
    const store=new SeriesStore(sql), now=Date.now(), start=now-8531*60000;
    const rows=Array.from({length:8531},(_,i)=>({key:'heart-'+i,kind:'heart',start:start+i*60000,end:start+(i+1)*60000,value:65,source:'Synthetic'}));
    this.storage.transactionSync(()=>store.put(rows,now));
    const since=start+3214*60000;
    const original=sql.exec('SELECT payload FROM samples WHERE kind=? AND start>=? ORDER BY start,key','heart',since);
    const originalRows=original.toArray();
    store.list('heart',since);
    const restarted=new SeriesStore(sql);
    const sum=()=>[...meter.pending.values()].reduce((n,v)=>n+v.reads,0);
    meter.pending.clear();
    const coldRows=restarted.list('heart',since), coldReads=sum();
    const coldRawReads=meter.pending.get('raw_history')?.reads??0;
    meter.pending.clear(); restarted.counts(); const countReads=sum();
    const originalCounts=sql.exec('SELECT kind,COUNT(*) AS n FROM samples GROUP BY kind');
    originalCounts.toArray();
    this.storage.transactionSync(()=>restarted.put([{...rows.at(-1),value:72}],now));
    meter.pending.clear();
    const corrected=restarted.list('heart',since), correctionReads=sum();
    const correctionRawQueries=meter.pending.get('raw_history')?.queries??0;
    const workoutStart=rows[0].start, workoutEnd=workoutStart+60*60000;
    const oldWorkout=sql.exec('SELECT payload FROM samples WHERE kind=? AND start>=? AND end<=? ORDER BY start,key','heart',workoutStart,workoutEnd);
    oldWorkout.toArray(); meter.pending.clear();
    const workout=restarted.listBetween('heart',workoutStart,workoutEnd), workoutReads=sum();
    meter.flush(now);
    const usage=meter.view(now).days;
    return Response.json({originalRows:originalRows.length,coldRows:coldRows.length,originalReads:original.rowsRead,
      coldReads,coldRawReads,countReads,originalCountReads:originalCounts.rowsRead,correctionReads,correctionRawQueries,correctedValue:corrected.at(-1).value,
      oldWorkoutReads:oldWorkout.rowsRead,workoutReads,workoutRows:workout.length,usage});
  }
}
export default {fetch(req,env){return env.PROBE.get(env.PROBE.idFromName('synthetic')).fetch(req);}};
`;
const root = fileURLToPath(new URL('.', import.meta.url));
const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [{
  name: 'read-budget-probe', compatibilityDate: '2026-09-01',
  modules: [{type:'ESModule',path:root+'probe.mjs',contents:script},
    ...['series','sql-usage','workouts','health-card'].map(name=>({type:'ESModule',path:root+name+'.mjs'}))],
  durableObjects: { PROBE: { className: 'Probe', useSQLite: true } },
}] }));
try {
  const response = await mf.dispatchFetch('http://local/');
  const result = await response.json();
  assert.equal(result.coldRows, result.originalRows);
  assert.equal(result.coldRawReads, 0);
  assert.ok(result.coldReads < result.originalReads / 100);
  assert.ok(result.countReads < 10);
  assert.equal(result.correctionRawQueries, 1);
  assert.equal(result.correctedValue, 72);
  assert.equal(result.workoutRows, 60);
  assert.ok(result.workoutReads < result.oldWorkoutReads / 20);
  assert.ok(result.usage.some(row => row.category === 'workout_heart' && row.rowsRead === result.workoutReads));
  console.log(JSON.stringify(result, null, 2));
} finally { await mf.dispose(); }
