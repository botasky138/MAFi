// Failure modes before making a clipped hot card a smaller response: a long digest still ships in
// full, a Unicode character breaks at the cut, a short text changes, or the event page loses its text.
import './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import type { HotEntry } from '@aihot/backend/events/hot';
import { loadHot, loadStoryDetail } from '@aihot/backend/publication/stories';

after(closeDb);
test('hot cards send a Unicode-safe excerpt while the event keeps its complete public text',async()=>{
  const at=new Date(Date.now()-60_000);
  const intro='摘要'.repeat(238)+'🤖'.repeat(4);
  const full=intro+'仅在详情显示'.repeat(300);
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES ('hot-card','Hot card','rss','T1','editorial','2100-01-01')`;
  const [story]=await sql<{id:number;public_id:string}[]>`INSERT INTO stories(public_id,title,summary)
    VALUES (${randomUUID()},'Hot card',${full}) RETURNING id,public_id`;
  const [fact]=await sql<{id:number}[]>`INSERT INTO facts(public_id,story_id,title)
    VALUES (${randomUUID()},${story!.id},'Hot card') RETURNING id`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES ('hot-card','hot-card','hot-card','https://example.org/hot-card','Hot card',${at},${at})`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES (${fact!.id},'hot-card','report')`;
  await sql`INSERT INTO publications(article_id,source_id,title,summary,url,timeline_at,discovered_at,sort_at,body_mode,eligible,channel,story_id,fact_id)
    VALUES ('hot-card','hot-card','Hot card',${full},'https://example.org/hot-card',${at},${at},${at},'summary',true,'news',${story!.id},${fact!.id})`;
  const entry:HotEntry={rank:1,storyId:story!.id,storyPublicId:story!.public_id,title:'Hot card',heat:10,trend:'flat',trendPct:0,badges:[],participantCount:0,sourceCount:1,signalCount:0,reportCount:1,sourceNames:['Hot card'],latestAt:at.toISOString(),firstReportAt:at.toISOString(),representativeItemId:'hot-card',representativeUrl:'https://example.org/hot-card',representativeSource:'Hot card',participants:[]};
  await sql`INSERT INTO hot_rankings(computed_at,rule_version,entries,published) VALUES (now(),'test',${sql.json([entry] as never)},true)`;
  assert.equal((await loadHot()).entries[0]!.summary,intro+'…');
  assert.equal((await loadStoryDetail(story!.id))!.summary,full,'the event remains the full reading surface');
  await sql`UPDATE stories SET summary='短摘要' WHERE id=${story!.id}`;
  await sql`UPDATE publications SET summary='短摘要' WHERE article_id='hot-card'`;
  assert.equal((await loadHot()).entries[0]!.summary,'短摘要');
});

// Failure mode (2026-11-01 to 11-12): the board was re-sorted by latest progress, newest first, so a
// fresher No.6 stood above No.5 and No.3 at the bottom. It keeps the ranking's order, as its numbers say.
test('the hot board lists events in rank order, not by their latest progress',async()=>{
  const entries:HotEntry[]=[];
  for(const [rank,hours] of [[1,30],[2,2],[3,50]] as const){
    const key=`hot-order-${rank}`, at=new Date(Date.now()-hours*3600_000);
    await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at) VALUES (${key},${key},'rss','T1','editorial','2100-01-01')`;
    const [story]=await sql<{id:number;public_id:string}[]>`INSERT INTO stories(public_id,title) VALUES (${randomUUID()},${key}) RETURNING id,public_id`;
    const [fact]=await sql<{id:number}[]>`INSERT INTO facts(public_id,story_id,title) VALUES (${randomUUID()},${story!.id},${key}) RETURNING id`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES (${key},${key},${key},${`https://example.org/${key}`},${key},${at},${at})`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES (${fact!.id},${key},'report')`;
    await sql`INSERT INTO publications(article_id,source_id,title,summary,url,timeline_at,discovered_at,sort_at,body_mode,eligible,channel,story_id,fact_id)
      VALUES (${key},${key},${key},'摘要',${`https://example.org/${key}`},${at},${at},${at},'summary',true,'news',${story!.id},${fact!.id})`;
    entries.push({rank,storyId:story!.id,storyPublicId:story!.public_id,title:key,heat:30-rank,trend:'flat',trendPct:0,badges:[],participantCount:2,sourceCount:2,signalCount:0,reportCount:1,sourceNames:[key],latestAt:at.toISOString(),firstReportAt:at.toISOString(),representativeItemId:key,representativeUrl:`https://example.org/${key}`,representativeSource:key,participants:[]});
  }
  await sql`INSERT INTO hot_rankings(computed_at,rule_version,entries,published) VALUES (now(),'test',${sql.json(entries as never)},true)`;
  assert.deepEqual((await loadHot()).entries.map((e)=>e.rank),[1,2,3]);
});
