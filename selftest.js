async function run(){
  const u='https://api.open-meteo.com/v1/forecast?latitude=21.0285&longitude=105.8542&current=temperature_2m&hourly=shortwave_radiation&forecast_days=1&timezone=auto';
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const r=await fetch(u,{signal:controller.signal});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const j=await r.json();
    if(!j.current||!Array.isArray(j.hourly?.shortwave_radiation)) throw new Error('Unexpected Open-Meteo payload');
    console.log(`[selftest] Open-Meteo OK · ${j.current.temperature_2m}°C · ${j.hourly.shortwave_radiation.length} hourly radiation points`);
  }catch(e){
    console.warn('[selftest] Open-Meteo unavailable:',e.message);
  }finally{clearTimeout(timer)}
}
run();
