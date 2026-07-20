import { config } from 'dotenv';
config({ path: '.env.local' });
import { filterResultsByEntity } from '../packages/tools/src/research_strategy.ts';

async function main() {
  // Case 1: thin entity — no domain, no context. Same-name collisions should be REJECTED now.
  const thin = await filterResultsByEntity(
    { name: 'PathPilot', domain: '', context: '' },
    [
      { id: 'a', title: 'PathPilot — Tormach CNC control software', url: 'https://tormach.com/pathpilot', text: 'PathPilot is the control software for Tormach CNC machines. Download the latest version for your mill or lathe.' },
      { id: 'b', title: 'PathPilot: AI for Fintech & Banking Operations | Shyft', url: 'https://shyft.ai/tools/pathpilot', text: 'PathPilot: AI Automation Platform for Fintech Support & Onboarding. Category: AI tools. Pricing: contact sales.' },
      { id: 'c', title: 'PathPilot raises seed round to automate BNPL collections', url: 'https://techcrunch.com/pathpilot-seed', text: 'PathPilot (getpathpilot.com), which builds AI agents for fintech collections and BNPL operations, announced a seed round today led by...' },
    ],
  );
  console.log('CASE 1 (thin, no domain/context):');
  console.log('  accepted:', [...thin.accepted], ' dropped:', thin.dropped);
  console.log('  expect: only "c" (explicitly references getpathpilot.com), a+b rejected\n');

  // Case 2: grounded entity — real context. Aggregator junk should be REJECTED, real news kept.
  const grounded = await filterResultsByEntity(
    { name: 'PathPilot', domain: 'getpathpilot.com', context: 'PathPilot Blog — PathPilot helps BNPL, embedded lending, and credit card fintechs automate operations so they can grow || offers_product: AI agents for fintech collections; target_market: BNPL and embedded lending fintechs' },
    [
      { id: 'd', title: 'PathPilot - aVenture Company Research', url: 'https://aventure.vc/companies/pathpilot-san-francisco-ca-us', text: 'PathPilot - aVenture Company Research. PathPilot. San Francisco, CA. AI Automation. Founded 2023. Employees: 11-50.' },
      { id: 'e', title: 'PathPilot: Verified Reviews & AI Trust Profile | Bilarna', url: 'https://bilarna.com/provider/getpathpilot', text: 'PathPilot. About: Reduce collection costs and scale automation safely. PathPilot profile page. Rating: unrated.' },
      { id: 'f', title: 'How PathPilot cut collections costs 40% at a top BNPL', url: 'https://fintechweekly.com/pathpilot-case-study', text: 'A deep dive into how PathPilot deployed AI agents at a buy-now-pay-later lender, cutting cost per resolved account 40% while passing compliance review. Interview with the founding team at getpathpilot.com.' },
      { id: 'g', title: 'PathPilot — Tormach CNC control software v2.10 release', url: 'https://tormach.com/pathpilot-release', text: 'The latest PathPilot release adds probing cycles for Tormach mills and lathes.' },
    ],
  );
  console.log('CASE 2 (grounded fintech PathPilot):');
  console.log('  accepted:', [...grounded.accepted], ' dropped:', grounded.dropped);
  console.log('  expect: only "f" (substantive + right company); d/e aggregator profiles rejected, g wrong company rejected');
}
main().catch((e) => { console.error(e); process.exit(1); });
