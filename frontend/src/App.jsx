import React, { useEffect, useRef, useState } from 'react';
import ChatMessage from './components/ChatMessage.jsx';
const API_BASE = "https://ledger-backend-c5t9.onrender.com";

/* =====================================================================================
   Helpers
===================================================================================== */
function daysPassed(dateString) {
  const now = new Date();
  const then = new Date(dateString);
  if (isNaN(then)) return 0;
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}
function ymd(dtStr) {
  const d = new Date(dtStr);
  return isNaN(d) ? dtStr : d.toISOString().slice(0, 10);
}
function hm(dtStr) {
  const d = new Date(dtStr);
  if (isNaN(d)) return '--:--';
  return d.toTimeString().slice(0, 5);
}
function startOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
function pad2(n){return n<10?`0${n}`:String(n)}
function parseLooseDateToken(tok){
  let m=tok.match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/i);
  if(m){const day=+m[1],month=+m[2],year=new Date().getFullYear();
    if(day>=1&&day<=31&&month>=1&&month<=12) return `${year}-${pad2(month)}-${pad2(day)}`;}
  m=tok.match(/^(\d{1,2})\s*\/\s*([A-Za-z]{3,9})$/i);
  if(m){const day=+m[1],key=m[2].toLowerCase().startsWith('sept')?'sept':m[2].toLowerCase().slice(0,3);
    const month=MONTHS[key],year=new Date().getFullYear(); if(day>=1&&day<=31&&month) return `${year}-${pad2(month)}-${pad2(day)}`;}
  m=tok.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m) return tok; return null;
}
function parseLooseDateOrRange(text){
  const range=text.trim().toLowerCase().replace(/\s+/g,' ');
  let parts=range.split('..'); if(parts.length===1) parts=range.split(' to ');
  if(parts.length===1){const d=parseLooseDateToken(range); return d?{from:d,to:d}:null;}
  if(parts.length===2){const d1=parseLooseDateToken(parts[0].trim()),d2=parseLooseDateToken(parts[1].trim()); if(d1&&d2) return {from:d1,to:d2};}
  return null;
}

/* =====================================================================================
   INVOICE HELPERS & API
===================================================================================== */
function parseInvoiceItem(line){
  // Accept: "desc - price - gst" (also supports | or , as separators; gst may have %)
  const m = line.match(/^(.+?)[\-\|,]\s*([0-9]+(?:\.[0-9]+)?)\s*[\-\|,]\s*([0-9]+(?:\.[0-9]+)?)%?$/i);
  if(!m) return null;
  return { description:m[1].trim(), price:parseFloat(m[2]), gstPercent:parseFloat(m[3]) };
}
async function apiCreateInvoice(payload){
  return fetch(`${API_BASE}/api/invoices`,{
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
  });
}

/* =====================================================================================
   Backend API
===================================================================================== */
async function apiGetUser(mobile){
  const r=await fetch(`${API_BASE}/api/user/${mobile}`);
  if(!r.ok) return null;
  return await r.json();
}
async function apiRegister(mobile,name){
  const r=await fetch(`${API_BASE}/api/register`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({mobile,name})
  });
  return r.ok;
}
async function apiListEntries(mobile){
  const r=await fetch(`${API_BASE}/api/user/${mobile}/entries`);
  if(!r.ok) return [];
  const d=await r.json();
  return d.items||[];
}
async function apiAddEntries(mobile,items){
  const r=await fetch(`${API_BASE}/api/user/${mobile}/entries`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({items})
  });
  return r.ok;
}
async function apiParseLLM(text){
  try{
    const r=await fetch(`${API_BASE}/api/parseMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:text})
    });
    const d=await r.json();
    if(!r.ok) return null;
    if(Array.isArray(d.items)) return d.items;
    if(typeof d.result==='string'){
      try{
        const obj=JSON.parse(d.result);
        if(Array.isArray(obj.items)) return obj.items;
      }catch{}
    }
    return null;
  }catch{return null;}
}
async function apiIngestInvoice(mobile,file){
  const fd=new FormData();
  fd.append('mobile',mobile);
  fd.append('file',file);
  const r=await fetch(`${API_BASE}/api/ingestInvoice`,{method:'POST',body:fd});
  const d=await r.json();
  return {ok:r.ok,data:d};
}
async function apiGetSettings(mobile){
  const r=await fetch(`${API_BASE}/api/user/${mobile}/settings`);
  if(!r.ok) return null;
  return await r.json();
}
async function apiUpdateSettings(mobile,payload){
  const r=await fetch(`${API_BASE}/api/user/${mobile}/settings`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
  return r.ok;
}
async function refreshEntriesForCurrentUser(currentUser,setEntries){
  if(!currentUser?.mobile) return;
  const fresh=await apiListEntries(currentUser.mobile);
  setEntries(fresh);
}

/* =====================================================================================
   UI Labels (English / Hindi)
===================================================================================== */

const LABELS = {
  en: {
    INSTRUCTIONS: 
`📋 How to add entries

👉 Sales:
: 1000 → Cash sale of ₹1000
: 1000 Ramesh → Sale of ₹1000, Ramesh still has to pay
: 50 unit Maggi Pack of 2 1000 → Sold 50 units of Maggi Pack of 2 for ₹1000

👉 Expenses:
: -250 → Paid ₹250 in cash
: -250 Ramesh cash → Paid ₹250 in cash to Ramesh
: -250 Ramesh → Goods/services taken from Ramesh, payment pending

👉 Repayments:
: Ramesh paid 1000 → Customer Ramesh repaid ₹1000 (inflow)
: Paid Dal Vendor 1250 → Vendor Dal Vendor repaid ₹1250 (outflow)`,

    SUMMARY_TITLE: (month)=>`📊 ${month} Summary:`,
    TOTAL_REVENUE: "Total Revenue",
    TOTAL_EXPENSE: "Total Expense",
    NET_PROFIT: "Net Profit / Loss",
    REVENUE_CASH: "Revenue (Cash)",
    REVENUE_CREDIT: "Revenue (Credit)",
    EXPENSE_CASH: "Expense (Cash)",
    EXPENSE_PAYABLE: "Expense (Payable)",
    DAY_WISE: "Day-wise totals:",
    INVENTORY_TITLE: "📦 Inventory — Month to date (SKU units):",
    CREDITORS_TITLE: "📒 Creditors — Month to date",
    TOTAL_RECEIVABLES: "Total Receivables",
    CUSTOMER_WISE: "Customer-wise:",
    PAYABLES_TITLE: "📚 Payables — Month to date",
    TOTAL_PAYABLES: "Total Payables",
    VENDOR_WISE: "Vendor-wise:",
    LEDGER: 'Ledger',
    SUMMARY: 'Summary',
    CREDITORS: 'Creditors',
    PAYABLES: 'Payables',
    SETTINGS: 'Settings',
    INVOICE: 'Invoice',
    INVENTORY: 'Inventory',
    BACK_TO_LEDGER: '✅ Back to Ledger. Add entries now.',
    GREETING_BI: '👋 Welcome / स्वागत है!\nPlease enter your mobile number to begin.\nकृपया शुरू करने के लिए अपना मोबाइल नंबर दर्ज करें।',
    WELCOME: (name) => `Welcome back, ${name}! You're in Ledger mode. Type entries directly, or commands: Summary / Inventory / Creditors / Payables / Settings / Invoice.`,
    REGISTER_WELCOME: (name) => `🎉 Registered successfully. Welcome ${name}! You're in Ledger mode. Type entries directly, or commands: Summary / Inventory / Creditors / Payables / Settings / Invoice.`,
    PLACEHOLDER: (L) => `Type here… (mobile → OTP → name → ${L.LEDGER} | ${L.SUMMARY} | ${L.INVENTORY} | ${L.CREDITORS} | ${L.PAYABLES} | ${L.SETTINGS} | ${L.INVOICE})`,
    SETTINGS_PANEL: (s)=>`⚙️ Settings:
• Store Name: ${s.store_name||'-'}
• Store Address: ${s.store_address||'-'}
• GST Number: ${s.store_gst||'-'}
• Contact Number: ${s.store_contact||'-'}

Update one field at a time:
- store name: My Shop
- store address: 12, MG Road, Pune
- gst: 27ABCDE1234Z1Z5
- contact: 9876543210

Type 'ledger' to go back.`,
    SETTINGS_SAVED: '✅ Saved. Type `show` to view, or update another field, or `ledger` to exit.',
    SETTINGS_FAIL: '❌ Failed to update settings.',
    CONFIRM_FIELD: (k,v)=>`You entered:\n${k}: ${v}\n\nType 'yes' to confirm or 'no' to re-enter.`,
    ENTER_INVOICE: '🧾 Create Invoice mode.\nStep 1/3 — Enter customer name:',
    ENTER_ITEMS_HELP:
`Step 2/3 — Add items (one per line):
Format: description - price - gst%
Example: 5kg Atta - 450 - 5

Type items now. When done, type 'done'. You can 'remove N', 'preview', or 'cancel'.`,
    ENTER_TERMS: `Step 3/3 — Enter payment terms (or type 'skip' for none).`,
    GENERATING: '🛠️ Generating your PDF invoice…',
    INVOICE_FAIL: '❌ Failed to generate invoice.',
    CANCELLED: '❎ Cancelled. Back to Ledger.',
    ADDED_ITEM: (it, idx)=>`✅ #${idx}) ${it.description} — ₹${it.price} • GST ${it.gstPercent}%`,
    REMOVED_ITEM: (n)=>`🗑️ Removed item #${n}.`,
    CONFIRM_CUSTOMER: (name)=>`You entered customer: “${name}”.\nType 'yes' to confirm or 'no' to re-enter.`,
    CONFIRM_ITEM: (it)=>`Add this item?\n${it.description} — ₹${it.price} • GST ${it.gstPercent}%\n\nType 'yes' to confirm or 'no' to re-enter.`,
    CONFIRM_TERMS: (terms)=>`Payment terms: “${terms || '— none —'}”.\nType 'yes' to confirm or 'no' to re-enter. (Or type 'skip' for none)`,
    PROMPT_CUSTOMER_AGAIN: 'Please enter the customer name:',
    PROMPT_ITEM_AGAIN: 'Enter item as: description - price - gst%',
    PROMPT_TERMS_AGAIN: 'Enter payment terms (or type skip):',
  },
  hi: {
    INSTRUCTIONS:
`📋 एंट्री कैसे जोड़ें

👉 बिक्री:
: १००० → ₹१००० की नकद बिक्री
: १००० रमेश → ₹१००० की बिक्री, रमेश से भुगतान बाकी
: ५० यूनिट मैगी पैक ऑफ़ २ १००० → ५० यूनिट मैगी पैक ऑफ़ २ बेचा ₹१००० में

👉 खर्च:
: -२५० → ₹२५० नकद भुगतान
: -२५० रमेश नकद → रमेश को ₹२५० नकद भुगतान
: -२५० रमेश → रमेश से सामान/सेवा लिया, भुगतान बाकी

👉 भुगतान:
: रमेश ने १००० चुकाए → ग्राहक रमेश ने ₹१००० लौटाए (आय)
: दल विक्रेता को १२५० चुकाए → विक्रेता को ₹१२५० चुकाए (खर्च)`,

    SUMMARY_TITLE: (month)=>`📊 ${month} हिसाब-किताब:`,
    TOTAL_REVENUE: "कुल आमदनी",
    TOTAL_EXPENSE: "कुल खर्च",
    NET_PROFIT: "शुद्ध लाभ / हानि",
    REVENUE_CASH: "नकद आमदनी",
    REVENUE_CREDIT: "उधार आमदनी",
    EXPENSE_CASH: "नकद खर्च",
    EXPENSE_PAYABLE: "देय खर्च",
    DAY_WISE: "दिनवार विवरण:",
    INVENTORY_TITLE: "📦 इन्वेंटरी — माह-से-तारीख (SKU यूनिट):",
    CREDITORS_TITLE: "📒 देनदार — माह-से-तारीख",
    TOTAL_RECEIVABLES: "कुल बकाया",
    CUSTOMER_WISE: "ग्राहकवार:",
    PAYABLES_TITLE: "📚 लेनदार — माह-से-तारीख",
    TOTAL_PAYABLES: "कुल देय",
    VENDOR_WISE: "विक्रेतावार:",
    LEDGER: 'बही-खाता',
    SUMMARY: 'हिसाब-किताब',
    CREDITORS: 'देनदार',
    PAYABLES: 'लेनदार',
    SETTINGS: 'सेटिंग्स',
    INVOICE: 'बिल',
    INVENTORY: 'इन्वेंटरी',
    BACK_TO_LEDGER: '✅ वापस बही-खाता मोड में।',
    GREETING_BI: '👋 Welcome / स्वागत है!\nPlease enter your mobile number to begin.\nकृपया शुरू करने के लिए अपना मोबाइल नंबर दर्ज करें।',
    WELCOME: (name) => `स्वागत है, ${name}! आप बही-खाता मोड में हैं। सीधे एंट्री टाइप करें, या कमांड: हिसाब-किताब / इन्वेंटरी / देनदार / लेनदार / सेटिंग्स / बिल।`,
    REGISTER_WELCOME: (name) => `🎉 रजिस्ट्रेशन सफल। स्वागत है ${name}! आप बही-खाता मोड में हैं। कमांड: हिसाब-किताब / इन्वेंटरी / देनदार / लेनदार / सेटिंग्स / बिल।`,
    PLACEHOLDER: (L) => `यहाँ लिखें… (mobile → OTP → name → ${L.LEDGER} | ${L.SUMMARY} | ${L.INVENTORY} | ${L.CREDITORS} | ${L.PAYABLES} | ${L.SETTINGS} | ${L.INVOICE})`,
    SETTINGS_PANEL: (s)=>`⚙️ सेटिंग्स:
• Store Name: ${s.store_name||'-'}
• Store Address: ${s.store_address||'-'}
• GST Number: ${s.store_gst||'-'}
• Contact Number: ${s.store_contact||'-'}

एक-एक फ़ील्ड अपडेट करें:
- store name: My Shop
- store address: 12, MG Road, Pune
- gst: 27ABCDE1234Z1Z5
- contact: 9876543210

'ledger' लिखकर वापस जाएँ।`,
    SETTINGS_SAVED: '✅ सेव हो गया। `show` लिखें देखने के लिए, या कोई और फ़ील्ड अपडेट करें, या `ledger` लिखें।',
    SETTINGS_FAIL: '❌ सेटिंग्स अपडेट नहीं हो पाईं।',
    CONFIRM_FIELD: (k,v)=>`आपने लिखा:\n${k}: ${v}\n\nपुष्टि के लिए 'yes' लिखें या 'no' लिखें।`,
    ENTER_INVOICE: '🧾 बिल बनाने का मोड।\nकदम 1/3 — ग्राहक का नाम लिखें:',
    ENTER_ITEMS_HELP:
`कदम 2/3 — आइटम जोड़ें (एक लाइन में एक):
फ़ॉर्मैट: विवरण - कीमत - जीएसटी%
उदाहरण: 5kg Atta - 450 - 5

अब आइटम टाइप करें। पूरा होने पर 'done' लिखें। 'remove N', 'preview', या 'cancel' लिख सकते हैं।`,
    ENTER_TERMS: `कदम 3/3 — भुगतान शर्तें लिखें (या 'skip' लिखें)।`,
    GENERATING: '🛠️ आपका पीडीएफ बिल बनाया जा रहा है…',
    INVOICE_FAIL: '❌ बिल बन नहीं सका।',
    CANCELLED: '❎ रद्द। वापस बही-खाता।',
    ADDED_ITEM: (it, idx)=>`✅ #${idx}) ${it.description} — ₹${it.price} • GST ${it.gstPercent}%`,
    REMOVED_ITEM: (n)=>`🗑️ आइटम #${n} हटा दिया।`,
    CONFIRM_CUSTOMER: (name)=>`ग्राहक: “${name}” — पुष्टि करें?\n'yes' लिखें या 'no' लिखें।`,
    CONFIRM_ITEM: (it)=>`यह आइटम जोड़ें?\n${it.description} — ₹${it.price} • GST ${it.gstPercent}%\n\n'yes' लिखें या 'no' लिखें।`,
    CONFIRM_TERMS: (terms)=>`भुगतान शर्तें: “${terms || '— नहीं —'}” — पुष्टि करें?\n'yes' लिखें या 'no' लिखें। (या 'skip' लिखें)`,
    PROMPT_CUSTOMER_AGAIN: 'कृपया ग्राहक का नाम लिखें:',
    PROMPT_ITEM_AGAIN: 'आइटम इस तरह लिखें: विवरण - कीमत - जीएसटी%',
    PROMPT_TERMS_AGAIN: 'भुगतान शर्तें लिखें (या skip):',
  }
};





/* =====================================================================================
   Component
===================================================================================== */
export default function App(){
  const [messages,setMessages]=useState([]);
  const [input,setInput]=useState('');
  // mode: 'mobile' -> 'otp' -> 'name' -> 'chooseLang' -> 'ledger'
  const [mode,setMode]=useState('mobile');
  const [subMode,setSubMode]=useState('ledger');  // ledger | inventory | summary | creditors | payables | settings | invoice
  const [currentUser,setCurrentUser]=useState(null);
  const [entries,setEntries]=useState([]);
  const [pendingMobile,setPendingMobile]=useState(null);
  const [expectedOtp,setExpectedOtp]=useState(null);
  const [pendingIsExisting, setPendingIsExisting] = useState(false);

  // language (persisted per mobile)
  const [uiLang, setUiLang] = useState('en');
  const L = LABELS[uiLang];

  // ===== CREATE INVOICE WIZARD STATE =====
  const [invoiceStep,setInvoiceStep]=useState(0); // 0=inactive, 1=customer, 2=items, 3=terms
  const [invCustomer,setInvCustomer]=useState('');
  const [invItems,setInvItems]=useState([]); // [{description,price,gstPercent}]
  const [invTerms,setInvTerms]=useState('');
  const [invoiceConfirm,setInvoiceConfirm]=useState(null); // {type:'customer'|'item'|'terms', value:any}

  // Settings confirmation state
  const [pendingSetting,setPendingSetting]=useState(null); // {key:'store_name', label:'Store Name', value:'...'} or null

  // Views & drilldowns
  const [invView,setInvView]=useState({context:'none',from:null,to:null,page:1,pageSize:20,rows:[]});
  const [sumView,setSumView]=useState({context:'none',date:null,page:1,pageSize:20,rows:[]});
  const [creditorQuery,setCreditorQuery]=useState('');
  const [vendorQuery,setVendorQuery]=useState('');

  // Settings cache
  const [settings,setSettings]=useState({store_name:'',store_address:'',store_gst:'',store_contact:''});

  const fileInputRef=useRef(null);
  const greetedRef = useRef(false);

  // ===== Language persistence helpers =====
  function getSavedLangForMobile(mob){
    try{
      const k = `lang:${mob}`;
      return localStorage.getItem(k) || null;
    }catch{ return null; }
  }
  function setSavedLangForMobile(mob, lang){
    try{
      localStorage.setItem(`lang:${mob}`, lang);
    }catch{}
  }

  // Initial bilingual greeting (avoid duplicates)
  useEffect(()=>{
    if (!greetedRef.current) {
      pushBot(LABELS.en.GREETING_BI); // bilingual greeting block
      greetedRef.current = true;
    }
  },[]);

  function pushBot(text){ setMessages(p=>[...p,{sender:'bot',text,ts:new Date().toISOString()}]); }
  function pushUser(text){ setMessages(p=>[...p,{sender:'user',text,ts:new Date().toISOString()}]); }

  // Small helper to prompt language selection
  function promptLanguageChoice(mob){
    pushBot(
`🌐 Choose your language / अपनी भाषा चुनें:
- Type **english** (or **en**) for English
- **हिंदी** टाइप करें (या **hi**) हिंदी के लिए

(You can switch anytime in the future.)`
    );
  }

  /* =====================================================================================
     Builders: Credit & Payables
  ===================================================================================== */
  function buildCreditorsMonthSummary(list){
    const som=startOfMonth(new Date());
    const rows=list.filter(e=>e.credit&&e.revenue>0&&new Date(e.date)>=som);
    if(!rows.length) return 'No outstanding credits for this month.';
    const byName=new Map();
    rows.forEach(e=>{
      const name=(e.creditor||'Unknown').trim();
      const key=name.toLowerCase();
      if(!byName.has(key)) byName.set(key,{name,total:0});
      byName.get(key).total+=e.revenue;
    });
    const groups=Array.from(byName.values()).sort((a,b)=>a.name.localeCompare(b.name));
    const monthTotal=rows.reduce((s,e)=>s+e.revenue,0);
    let out = `${L.CREDITORS_TITLE}\n${L.TOTAL_RECEIVABLES}: ₹${monthTotal}\n\n${L.CUSTOMER_WISE}\n`;
    groups.forEach(g=>{out+=`- ${g.name}: ₹${g.total}\n`;});
    out+=`\n(Type a customer name to view date-wise details, or 'ledger' to go back.)`;
    return out;
  }
  function buildCreditorDetails(list,nameQuery){
    const som=startOfMonth(new Date());
    const q=nameQuery.trim().toLowerCase();
    const rows=list.filter(e=>
      e.credit&&e.revenue>0&&new Date(e.date)>=som&&(e.creditor||'').trim().toLowerCase()===q
    );
    if(!rows.length) return `No entries for "${nameQuery}" this month.`;
    rows.sort((a,b)=>new Date(a.date)-new Date(b.date));
    let out=`📒 Date-wise (Month to date)\n`;
    rows.forEach(e=>{
      out+=`${ymd(e.date)}, ₹${e.revenue}, Item bought by customer: ${e.product}, ${daysPassed(e.date)} days pending\n`;
    });
    const total=rows.reduce((s,e)=>s+e.revenue,0);
    out+=`\nSubtotal: ₹${total}\n(Type another customer name, or 'ledger' to go back.)`;
    return out;
  }

  function buildPayablesMonthSummary(list){
    const som=startOfMonth(new Date());
    const rows=list.filter(e=>e.credit&&e.revenue<0&&new Date(e.date)>=som);
    if(!rows.length) return 'No outstanding payables for this month.';
    const byVendor=new Map();
    rows.forEach(e=>{
      const name=(e.creditor||'Unknown Vendor').trim();
      const key=name.toLowerCase();
      if(!byVendor.has(key)) byVendor.set(key,{name,total:0});
      byVendor.get(key).total+=Math.abs(e.revenue);
    });
    const groups=Array.from(byVendor.values()).sort((a,b)=>a.name.localeCompare(b.name));
    const monthTotal=rows.reduce((s,e)=>s+Math.abs(e.revenue),0);
    let out = `${L.PAYABLES_TITLE}\n${L.TOTAL_PAYABLES}: ₹${monthTotal}\n\n${L.VENDOR_WISE}\n`;
    groups.forEach(g=>{out+=`- ${g.name}: ₹${g.total}\n`;});
    out+=`\n(Type a vendor name to view date-wise details, or 'ledger' to go back.)`;
    return out;
  }
  function buildPayableDetails(list,vendorName){
    const som=startOfMonth(new Date());
    const q=vendorName.trim().toLowerCase();
    const rows=list.filter(e=>
      e.credit&&e.revenue<0&&new Date(e.date)>=som&&(e.creditor||'').trim().toLowerCase()===q
    );
    if(!rows.length) return `No entries for "${vendorName}" this month.`;
    rows.sort((a,b)=>new Date(a.date)-new Date(b.date));
    let out=`📚 Date-wise (Month to date)\n`;
    rows.forEach(e=>{
      const head=e.product?.startsWith('Expense: ')?e.product.slice(9).trim():(e.product||'Expense');
      out+=`${ymd(e.date)}, ₹${Math.abs(e.revenue)}, Payable head: ${head}, ${daysPassed(e.date)} days pending\n`;
    });
    const total=rows.reduce((s,e)=>s+Math.abs(e.revenue),0);
    out+=`\nSubtotal: ₹${total}\n(Type another vendor name, or 'ledger' to go back.)`;
    return out;
  }

  // ===== Invoice Preview (only on explicit 'preview' command) =====
  function buildInvoicePreview(itemsParam = null, customerParam = null, settingsParam = null) {
    const items = itemsParam ?? invItems;
    const customer = (customerParam ?? invCustomer) || '-';
    const s = settingsParam ?? settings;

    const sub = items.reduce((sum, i) => sum + (+i.price || 0), 0);
    const gst = items.reduce((sum, i) => sum + ((+i.price || 0) * ((+i.gstPercent || 0) / 100)), 0);
    const grand = sub + gst;
    const inr = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n || 0);

    const lines = [];
    lines.push('🧾 Invoice Preview');
    lines.push(`Store: ${s?.store_name||'-'}`);
    if (s?.store_address || s?.store_gst || s?.store_contact) {
      const extra = [
        s?.store_address ? `Address: ${s.store_address}` : null,
        s?.store_gst ? `GSTIN: ${s.store_gst}` : null,
        s?.store_contact ? `Contact: ${s.store_contact}` : null,
      ].filter(Boolean).join(' | ');
      if (extra) lines.push(extra);
    }
    lines.push('');
    lines.push(`Customer: ${customer}`);
    lines.push('');
    lines.push('Items:');
    if (!items.length) lines.push('(none yet)');
    items.forEach((it, idx) => {
      const price = +it.price || 0;
      const g = +it.gstPercent || 0;
      const tax = price * (g / 100);
      lines.push(`${idx + 1}) ${it.description} — ${inr(price)} | GST ${g}% (${inr(tax)}) | Line ${inr(price + tax)}`);
    });
    lines.push('');
    lines.push(`Subtotal: ${inr(sub)}`);
    lines.push(`GST: ${inr(gst)}`);
    lines.push(`Grand Total: ${inr(grand)}`);
    return lines.join('\n');
  }

  /* =====================================================================================
     Upload invoice
  ===================================================================================== */
  async function handleInvoiceUpload(file){
    if(!currentUser?.mobile){
      pushBot("Please login first (enter your mobile number).");
      return;
    }
    const {ok,data}=await apiIngestInvoice(currentUser.mobile,file);
    if(!ok){
      pushBot(`❌ Invoice parsing failed: ${data?.error||'Unknown error'}`);
      return;
    }
    await refreshEntriesForCurrentUser(currentUser,setEntries);
    pushBot(`✅ Processed invoice from **${data.vendor||'Vendor'}**. Added ${data.inserted||0} payable item(s), total ₹${data.total_amount||0}. Type 'payables' to view, or 'ledger' to continue.`);
  }

  /* =====================================================================================
     Chat logic
  ===================================================================================== */
  async function handleUserInput(raw){
    const text=raw.trim();
    if(!text) return;
    pushUser(text);

    // === ENTER CREATE-INVOICE from anywhere ===
    if(/^(create\s+invoice|invoice|bill|बिल)$/i.test(text)){
      setSubMode('invoice');
      setInvoiceStep(1); setInvCustomer(''); setInvItems([]); setInvTerms(''); setInvoiceConfirm(null);
      return pushBot(L.ENTER_INVOICE);
    }

    // Manual refresh
    if(/^refresh$/i.test(text)){
      await refreshEntriesForCurrentUser(currentUser,setEntries);
      return pushBot(`🔄 Synced. Try: ${L.SUMMARY} / ${L.INVENTORY} / ${L.CREDITORS} / ${L.PAYABLES} / ${L.SETTINGS} / ${L.INVOICE}.`);
    }

    // Registration / Login flow (OTP for both existing & new)
    if (mode === 'mobile') {
      const nm = text.replace(/\D/g, '');
      if (!nm) return pushBot('Please enter a valid mobile number (digits only).');

      // if we have a saved language for this mobile, apply it immediately
      const savedLang = getSavedLangForMobile(nm);
      if (savedLang) setUiLang(savedLang);

      const user = await apiGetUser(nm); // null when 404

      // Generate mock OTP
      const otp = Math.floor(1000 + Math.random() * 9000).toString();
      setExpectedOtp(otp);
      setPendingMobile(nm);

      if (user) {
        // EXISTING user → ask OTP too
        setPendingIsExisting(true);
        setMode('otp');
        return pushBot(
          `🔑 Please enter OTP sent to ${nm}. (Mock OTP is ${otp}).\n` +
          `🔑 कृपया ${nm} पर भेजा गया OTP दर्ज करें। (मॉक OTP है ${otp}).`
        );
      } else {
        // NEW user → ask OTP then name
        setPendingIsExisting(false);
        setMode('otp');
        return pushBot(
          `🔑 Please enter OTP sent to ${nm}. (Mock OTP is ${otp}).\n` +
          `🔑 कृपया ${nm} पर भेजा गया OTP दर्ज करें। (मॉक OTP है ${otp}).`
        );
      }
    }

    if (mode === 'otp') {
      if (text === expectedOtp) {
        // Reset OTP state
        setExpectedOtp(null);

        if (pendingIsExisting) {
          // Update names for these two numbers on login
          if (pendingMobile === '7042125595') await apiRegister(pendingMobile, 'Manoj');
          if (pendingMobile === '7042125590') await apiRegister(pendingMobile, 'Swadha Ben');

          // fetch user
          const user = await apiGetUser(pendingMobile);
          setCurrentUser({ mobile: user?.mobile || pendingMobile, name: user?.name || `User ${pendingMobile}` });
          await refreshEntriesForCurrentUser({ mobile: pendingMobile }, setEntries);

          // language: saved? else ask to choose
          let lang = getSavedLangForMobile(pendingMobile);
          if (!lang) {
            setMode('chooseLang');
            return promptLanguageChoice(pendingMobile);
          }
          setUiLang(lang);
          setSavedLangForMobile(pendingMobile, lang);

          setMode('ledger'); setSubMode('ledger');
          setPendingMobile(null); setPendingIsExisting(false);
          return pushBot(
          LABELS[lang].WELCOME(user?.name || `User ${pendingMobile}`) 
          + "\n\n" 
          + LABELS[lang].INSTRUCTIONS
        );
        }

        // NEW USER → proceed to ask for name
        setMode('name');
        return pushBot('✅ OTP verified. Please enter your name.');
      }
      return pushBot('❌ Invalid OTP. Try again.');
    }

    if (mode === 'name') {
      const name = text.trim();
      const mobile = pendingMobile;
      if (!name) return pushBot('Please enter a valid name.');

      const ok = await apiRegister(mobile, name);
      if(!ok) return pushBot('Registration failed. Try again.');

      setCurrentUser({mobile, name});
      await refreshEntriesForCurrentUser({mobile}, setEntries);

      // After registration, if no saved language, go to chooseLang
      let lang = getSavedLangForMobile(mobile);
      if (!lang) {
        setMode('chooseLang');
        return promptLanguageChoice(mobile);
      }

      // Otherwise proceed (this branch rarely hits because we just registered)
      setUiLang(lang);
      setSavedLangForMobile(mobile, lang);
      setMode('ledger'); setSubMode('ledger');
      const msg = LABELS[lang].REGISTER_WELCOME(name) + "\n\n" + LABELS[lang].INSTRUCTIONS;
      setPendingMobile(null);
      return pushBot(msg);
    }

    // === Language choosing step ===
    if (mode === 'chooseLang') {
      const t = text.trim().toLowerCase();
      let chosen = null;

      if (/(^en(g(lish)?)?$)/i.test(t) || t === 'english') chosen = 'en';
      if (!chosen && (/^(hi|hindi|हिंदी|हिन्दी)$/i.test(t))) chosen = 'hi';

      if (!chosen) {
        // nudge again
        promptLanguageChoice(pendingMobile || currentUser?.mobile || '');
        return;
      }

      const mob = pendingMobile || currentUser?.mobile || '';
      if (mob) setSavedLangForMobile(mob, chosen);
      setUiLang(chosen);

      setMode('ledger'); setSubMode('ledger');

      const name = currentUser?.name || (mob ? `User ${mob}` : 'User');
      // if we came from existing login, clear pending flags
      setPendingMobile(null);
      setPendingIsExisting(false);

      // Use REGISTER_WELCOME if coming from registration, else WELCOME
      if (!pendingIsExisting) {
        return pushBot(
          LABELS[chosen].REGISTER_WELCOME(name) + "\n\n" + LABELS[chosen].INSTRUCTIONS
        );
      } else {
        return pushBot(
          LABELS[chosen].WELCOME(name) + "\n\n" + LABELS[chosen].INSTRUCTIONS
        );
      }
    }

    // Global exit back to Ledger from any sub-mode
    if(subMode!=='ledger' && /^(ledger|बही[ -]?खाता)$/i.test(text)){
      setSubMode('ledger');
      setInvView({context:'none',from:null,to:null,page:1,pageSize:20,rows:[]});
      setSumView({context:'none',date:null,page:1,pageSize:20,rows:[]});
      setCreditorQuery(''); setVendorQuery('');
      setPendingSetting(null);
      setInvoiceConfirm(null);
      return pushBot(L.BACK_TO_LEDGER);
    }

    // === GLOBAL: Enter SETTINGS from anywhere ===
    if(/^(settings?|सेटिंग्स)$/i.test(text)){
      if(!currentUser?.mobile) return pushBot('Please login first.');
      const s=await apiGetSettings(currentUser.mobile) || {};
      setSettings({
        store_name:s.store_name||'',
        store_address:s.store_address||'',
        store_gst:s.store_gst||'',
        store_contact:s.store_contact||'',
      });
      setSubMode('settings');
      setPendingSetting(null);
      return pushBot(L.SETTINGS_PANEL(s));
    }

    // Inside Settings (update one field at a time with confirmation)
    if(subMode==='settings'){
      // If confirmation is pending
      if(pendingSetting){
        if(/^(yes|y|haan|हाँ|ha|ok)$/i.test(text)){
          const payload = { [pendingSetting.key]: pendingSetting.value };
          const ok = await apiUpdateSettings(currentUser.mobile, payload);
          if(!ok) return pushBot(L.SETTINGS_FAIL);
          setSettings(prev=>({...prev, ...payload}));
          setPendingSetting(null);
          return pushBot(L.SETTINGS_SAVED);
        }
        if(/^(no|n|nah|नहीं|nai)$/i.test(text)){
          setPendingSetting(null);
          return pushBot(L.SETTINGS_PANEL(settings));
        }
        return pushBot(L.CONFIRM_FIELD(pendingSetting.label, pendingSetting.value));
      }

      if(/^show$/i.test(text)){
        const s=await apiGetSettings(currentUser.mobile) || {};
        setSettings({
          store_name:s.store_name||'',
          store_address:s.store_address||'',
          store_gst:s.store_gst||'',
          store_contact:s.store_contact||'',
        });
        return pushBot(L.SETTINGS_PANEL(s));
      }

      // Parse "field: value" (English keys)
      const m=text.match(/^(store name|name|store address|address|gst|gst number|contact|contact number)\s*[:\-]\s*(.+)$/i);
      if(m){
        const field=m[1].toLowerCase().trim();
        const value=m[2].trim();
        let key=''; let label='';
        if(field==='store name'||field==='name'){ key='store_name'; label='Store Name'; }
        else if(field==='store address'||field==='address'){ key='store_address'; label='Store Address'; }
        else if(field==='gst'||field==='gst number'){ key='store_gst'; label='GST Number'; }
        else if(field==='contact'||field==='contact number'){ key='store_contact'; label='Contact Number'; }
        if(!key) return pushBot(L.SETTINGS_PANEL(settings));
        setPendingSetting({key, label, value});
        return pushBot(L.CONFIRM_FIELD(label, value));
      }

      // Help text (same as panel)
      return pushBot(L.SETTINGS_PANEL(settings));
    }

    /* ------------------------------------------------------------------------------
       Ledger mode entry points
    ------------------------------------------------------------------------------ */
    if(mode==='ledger' && subMode==='ledger'){
      // INVENTORY
      if(/^(inventory|इन्वेंटरी)$/i.test(text)){
        await refreshEntriesForCurrentUser(currentUser,setEntries);
        if(!entries.length) return pushBot('No entries yet.');
        const som=startOfMonth(new Date());
        const monthSales=entries.filter(e=>e.revenue>0&&new Date(e.date)>=som);
        if(!monthSales.length) return pushBot('No sales recorded this month.');
        const skuMap=new Map();
        monthSales.forEach(e=>{
          const key=(e.product||'Unknown').trim();
          skuMap.set(key,(skuMap.get(key)||0)+(Number(e.units)||0));
        });
        const monthSkuRows=Array.from(skuMap.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
        let out = `${L.INVENTORY_TITLE}\n`;
        monthSkuRows.forEach(([prod,units])=>{out+=`- ${prod}: ${units} units\n`;});
        setSubMode('inventory');
        setInvView({context:'inventory',from:null,to:null,page:1,pageSize:20,rows:[]});
        out+='\n(Enter a date like `12/08` or `12/aug`, a range like `12/08..15/08`, or type `ledger` to go back.)';
        return pushBot(out);
      }

      // SUMMARY
      if (/^(summary|हिसाब[ -]?किताब)$/i.test(text)) {
        try {
          await refreshEntriesForCurrentUser(currentUser, setEntries);
          if (!entries.length) return pushBot('No entries yet.');

          const now = new Date(), som = startOfMonth(now);
          const monthEntries = entries.filter(e => new Date(e.date) >= som);

          let cashIn = 0, creditIn = 0, outPaid = 0, outPayable = 0;
          const byDay = new Map();

          monthEntries.forEach(e => {
            const isExpense = e.revenue < 0;
            const hasPaid = (e.product || '').toLowerCase().includes('paid');
            const paid = isExpense && (hasPaid || !e.credit);
            const payable = isExpense && !hasPaid && !!e.credit;

            const day = ymd(e.date);
            if (!byDay.has(day)) byDay.set(day, { cash: 0, credit: 0, outPaid: 0, outPayable: 0, tx: 0 });
            const b = byDay.get(day);
            b.tx += 1;

            if (paid) {
              outPaid += Math.abs(e.revenue); b.outPaid += Math.abs(e.revenue);
            } else if (payable) {
              outPayable += Math.abs(e.revenue); b.outPayable += Math.abs(e.revenue);
            } else if (e.revenue > 0 && e.credit) {
              creditIn += e.revenue; b.credit += e.revenue;
            } else if (e.revenue > 0) {
              cashIn += e.revenue; b.cash += e.revenue;
            }
          });

          const totalIncome = cashIn + creditIn;
          const totalExpense = outPaid + outPayable;
          const net = totalIncome - totalExpense;
          let msg = `${L.SUMMARY_TITLE(now.toLocaleString('default', { month: 'long' }))}\n`;
          msg += `${L.TOTAL_REVENUE} : ₹${totalIncome}\n`;
          msg += `${L.TOTAL_EXPENSE} : ₹${totalExpense}\n`;
          msg += `${L.NET_PROFIT} : ₹${net}\n`;
          msg += `————————\n`;
          msg += `${L.REVENUE_CASH} : ₹${cashIn}\n`;
          msg += `${L.REVENUE_CREDIT} : ₹${creditIn}\n`;
          msg += `————————-\n`;
          msg += `${L.EXPENSE_CASH} : ₹${outPaid}\n`;
          msg += `${L.EXPENSE_PAYABLE} : ₹${outPayable}\n`;
          msg += `\n— — — — — — — —\n${L.DAY_WISE}\n`;

          msg += '\n— — — — — — — —\nDay-wise totals:\n';
          const days = Array.from(byDay.entries()).sort((a, b) => b[0].localeCompare(a[0]));
          days.forEach(([day, v]) => {
            const netDay = v.cash + v.credit - (v.outPaid + v.outPayable);
            msg += `- ${day}: Tx ${v.tx} • Cash ₹${v.cash}, Credit ₹${v.credit}, Paid ₹${v.outPaid}, Payable ₹${v.outPayable}, Net ₹${netDay}\n`;
          });

          setSubMode('summary');
          setSumView({ context: 'summary', date: null, page: 1, pageSize: 20, rows: [] });
          msg += `\n(Type a date like \`12/08\` or \`12/aug\` to see that day, or \`ledger\` to go back.)`;
          return pushBot(msg);
        } catch (err) {
          console.error('SUMMARY error:', err);
          return pushBot('Sorry, I hit an error while building the summary.');
        }
      }

      // CREDITORS / PAYABLES
      if(/^(creditors?|देनदार)$/i.test(text)){
        await refreshEntriesForCurrentUser(currentUser,setEntries);
        const out=buildCreditorsMonthSummary(entries);
        setSubMode('creditors');
        setCreditorQuery('');
        return pushBot(out);
      }
      if(/^(payables?|लेनदार)$/i.test(text)){
        await refreshEntriesForCurrentUser(currentUser,setEntries);
        const out=buildPayablesMonthSummary(entries);
        setSubMode('payables');
        setVendorQuery('');
        return pushBot(out);
      }

      // Add new entry via LLM
      
      const parsed = await apiParseLLM(text);
      if (!parsed) {
        return pushBot("Couldn't parse that entry. Try: '2 colgate 100 ml 104 rs', '1 surf excel 1 kg 210 rs credit to Ramesh', '- 250 electricity paid', '-1200 rent payable to Landlord'.");
      }


      const normalized = parsed.map(it => {
        const hasUnitsAndProduct =
          it.product &&
          it.product.trim() !== "" &&
          it.units &&
          Number(it.units) > 0;

        if (hasUnitsAndProduct) {
          return {
            product: String(it.product).trim(),
            units: Number(it.units),
            revenue: Number(it.revenue || 0),
            credit: !!it.credit,
            creditor: it.credit ? String(it.creditor || "") : "",
            date: new Date().toISOString(),
          };
        }

        // Pure money entry (cash/expense/credit only → no units)
        return {
          product: it.product ?? null,  // ✅ keep null if backend says so
          units: null,
          revenue: Number(it.revenue || 0),
          credit: !!it.credit,
          creditor: it.credit ? String(it.creditor || "") : "",
          date: new Date().toISOString(),
        };
      }).filter(it => it.revenue !== 0);

      if (!normalized.length) return pushBot("Nothing to save for that entry.");

      const ok = await apiAddEntries(currentUser.mobile, normalized);   // ✅ only one await here
      if (!ok) return pushBot('Failed to save entry to database.');

      await refreshEntriesForCurrentUser(currentUser, setEntries);
      return pushBot(
        `Saved ${normalized.length} item(s). Try: ${L.SUMMARY} / ${L.INVENTORY} / ${L.CREDITORS} / ${L.PAYABLES} / ${L.SETTINGS} / ${L.INVOICE}.`
        );
    }

    /* ------------------------------------------------------------------------------
       Sub-mode interactions (Inventory, Summary drilldowns, Creditors, Payables, Invoice)
    ------------------------------------------------------------------------------ */

    // ======================================================================
    // CREATE INVOICE FLOW (chat wizard) with confirmations
    // ======================================================================
    if(subMode==='invoice'){
      // Global cancel
      if(/^cancel$/i.test(text)){
        setSubMode('ledger'); setInvoiceStep(0); setInvoiceConfirm(null);
        return pushBot(L.CANCELLED);
      }

      // If any confirmation pending (customer / item / terms), handle yes/no here
      if(invoiceConfirm){
        const yes = /^(yes|y|haan|हाँ|ha|ok)$/i.test(text);
        const no  = /^(no|n|नहीं|nai)$/i.test(text) || (/^skip$/i.test(text) && invoiceConfirm.type==='terms' && invoiceConfirm.value==='');
        if(yes){
          if(invoiceConfirm.type==='customer'){
            setInvCustomer(invoiceConfirm.value);
            setInvoiceConfirm(null);
            setInvoiceStep(2);
            return pushBot(L.ENTER_ITEMS_HELP);
          }
          if(invoiceConfirm.type==='item'){
            const added=[...invItems, invoiceConfirm.value];
            setInvItems(added);
            setInvoiceConfirm(null);
            return pushBot(L.ADDED_ITEM(invoiceConfirm.value, added.length));
          }
          if(invoiceConfirm.type==='terms'){
            setInvTerms(invoiceConfirm.value);
            setInvoiceConfirm(null);

            // Pull store details if not cached
            let biz=settings;
            if(!settings.store_name && currentUser?.mobile){
              const s=await apiGetSettings(currentUser.mobile);
              if(!s || !s.store_name){
                pushBot(uiLang==='en'
                  ? '⚠️ Your store details look empty. Set them via "settings" for a proper header.'
                  : '⚠️ आपके स्टोर विवरण खाली लग रहे हैं। सही हेडर के लिए "settings" में सेट करें।');
                biz=s||{};
              } else biz=s;
            }

            pushBot(L.GENERATING);

            const res=await apiCreateInvoice({
              customer:{name:invCustomer},
              items:invItems,
              paymentTerms:invoiceConfirm.value,
              business:{
                store_name:biz?.store_name||'',
                store_address:biz?.store_address||'',
                store_gst:biz?.store_gst||'',
                store_contact:biz?.store_contact||'',
              }
            });

            if(!res.ok){
              setSubMode('ledger'); setInvoiceStep(0);
              return pushBot(L.INVOICE_FAIL);
            }

            const blob=await res.blob();
            const url=window.URL.createObjectURL(blob);
            const ts=new Date().toISOString().slice(0,10);
            const fileName=`invoice_${ts}.pdf`;

            // auto-download
            const a=document.createElement('a');
            a.href=url; a.download=fileName;
            document.body.appendChild(a); a.click(); a.remove();

            // post link in chat
            pushBot(`📎 ${uiLang==='en'?'Invoice generated for':'बिल तैयार'} ${invCustomer} — ${fileName}\n${url}`);

            setSubMode('ledger'); setInvoiceStep(0);
            return;
          }
        }
        if(no){
          // Re-prompt the same input
          const promptMap = {
            customer: L.PROMPT_CUSTOMER_AGAIN,
            item: L.PROMPT_ITEM_AGAIN,
            terms: L.PROMPT_TERMS_AGAIN
          };
          setInvoiceConfirm(null);
          return pushBot(promptMap[invoiceConfirm.type]);
        }
        // If not yes/no while awaiting confirm, repeat confirm message
        if(invoiceConfirm.type==='customer') return pushBot(L.CONFIRM_CUSTOMER(invoiceConfirm.value));
        if(invoiceConfirm.type==='item')     return pushBot(L.CONFIRM_ITEM(invoiceConfirm.value));
        if(invoiceConfirm.type==='terms')    return pushBot(L.CONFIRM_TERMS(invoiceConfirm.value));
      }

      // Normal step flow when no confirmation is pending
      if (invoiceStep===1){
        if(!text.trim()) return pushBot(uiLang==='en'? 'Please enter a valid customer name, or type cancel.' : 'कृपया ग्राहक का सही नाम लिखें, या cancel लिखें।');
        const cust=text.trim();
        setInvoiceConfirm({type:'customer', value:cust});
        return pushBot(L.CONFIRM_CUSTOMER(cust));
      }

      if(invoiceStep===2){
        if(/^preview$/i.test(text)){
          return pushBot(buildInvoicePreview());
        }
        if(/^done$/i.test(text)){
          if(!invItems.length) return pushBot(uiLang==='en'?'Add at least one item before continuing.':'कृपया पहले एक आइटम जोड़ें।');
          setInvoiceStep(3);
          return pushBot(L.ENTER_TERMS);
        }
        const rem = text.match(/^remove\s+(\d+)$/i);
        if(rem){
          const idx = parseInt(rem[1],10)-1;
          if(idx<0 || idx>=invItems.length) return pushBot(uiLang==='en'?'No such item number.':'ऐसा कोई आइटम क्रमांक नहीं।');
          const next = invItems.slice(); next.splice(idx,1); setInvItems(next);
          return pushBot(L.REMOVED_ITEM(idx+1));
        }
        const parsed = parseInvoiceItem(text);
        if(!parsed) return pushBot(uiLang==='en'
          ? `Couldn't parse item. Use: description - price - gst\nExample: "5kg Atta - 450 - 5"`
          : `आइटम समझ नहीं आया। फ़ॉर्मैट: विवरण - कीमत - जीएसटी\nउदाहरण: "5kg Atta - 450 - 5"`);
        setInvoiceConfirm({type:'item', value:parsed});
        return pushBot(L.CONFIRM_ITEM(parsed));
      }

      if (invoiceStep === 3) {
        if(/^skip$/i.test(text)){
          setInvoiceConfirm({type:'terms', value:''});
          return pushBot(L.CONFIRM_TERMS(''));
        }
        const terms = text.trim();
        setInvoiceConfirm({type:'terms', value:terms});
        return pushBot(L.CONFIRM_TERMS(terms));
      }
    }

    if(subMode==='inventory'){
      const range=parseLooseDateOrRange(text);
      if(range && invView.context==='inventory'){
        if(!entries.length) return pushBot('No entries yet.');
        const fromD=new Date(range.from+'T00:00:00Z');
        const toD=new Date(range.to+'T23:59:59Z');
        const periodSales=entries.filter(e=>e.revenue>0&&new Date(e.date)>=fromD&&new Date(e.date)<=toD);
        const skuMap=new Map();
        periodSales.forEach(e=>{
          const key=(e.product||'Unknown').trim();
          skuMap.set(key,(skuMap.get(key)||0)+(Number(e.units)||0));
        });
        const rows=Array.from(skuMap.entries())
          .map(([prod,units])=>({prod,units}))
          .sort((a,b)=>b.units-a.units||a.prod.localeCompare(b.prod));

        const pageSize=invView.pageSize||20;
        setInvView({context:'inventory_detail',from:range.from,to:range.to,page:1,pageSize,rows});

        const total=rows.length;
        const totalPages=Math.max(1,Math.ceil(total/pageSize));
        const slice=rows.slice(0,pageSize);
        let out=`📦 ${L.INVENTORY} — ${range.from}${range.from!==range.to?` to ${range.to}`:''} (Page 1/${totalPages}, ${pageSize}/page)\n`;
        if(!slice.length) out+='No sales in this period.';
        slice.forEach((r,idx)=>{out+=`${idx+1}) ${r.prod}: ${r.units} units\n`;});
        if(totalPages>1) out+=`Type: next / prev / page N`;
        return pushBot(out);
      }
      if((/^next$/i.test(text)||/^prev$/i.test(text)||/^page\s+\d+$/i.test(text)) && invView.context==='inventory_detail'){
        let {page,pageSize,rows,from,to}=invView;
        const total=rows.length,totalPages=Math.max(1,Math.ceil(total/pageSize));
        if(/^next$/i.test(text)) page=Math.min(totalPages,page+1);
        if(/^prev$/i.test(text)) page=Math.max(1,page-1);
        const pm=text.match(/^page\s+(\d+)$/i); if(pm) page=Math.min(totalPages,Math.max(1,parseInt(pm[1],10)));
        setInvView({...invView,page});
        const start=(page-1)*pageSize;
        const slice=rows.slice(start,start+pageSize);
        let out=`📦 ${L.INVENTORY} — ${from}${from!==to?` to ${to}`:''} (Page ${page}/${totalPages}, ${pageSize}/page)\n`;
        slice.forEach((r,idx)=>{out+=`${start+idx+1}) ${r.prod}: ${r.units} units\n`;});
        if(totalPages>1) out+=`Type: next / prev / page N`;
        return pushBot(out);
      }
    }

    if(subMode==='summary'){
      const range=parseLooseDateOrRange(text);
      if(range && range.from===range.to && sumView.context==='summary'){
        if(!entries.length) return pushBot('No entries yet.');
        const day=range.from;
        const dayEntries=entries
          .filter(e=>ymd(e.date)===day)
          .sort((a,b)=>new Date(a.date)-new Date(b.date));

        const rows = dayEntries.map(e => {
          const isExpense = e.revenue < 0;
          const hasPaid = (e.product || '').toLowerCase().includes('paid');
          const isExpensePaid = isExpense && (hasPaid || !e.credit);

          let tag;
          if (isExpense) {
            tag = isExpensePaid ? 'Expense Paid' : `Expense Payable${e.creditor ? ':'+e.creditor : ''}`;
          } else {
            if (e.credit) {
              tag = `Credit${e.creditor ? ':'+e.creditor : ''}`;
            } else {
              tag = 'Cash';
            }
          }

          const amt = e.revenue < 0 ? `-₹${Math.abs(e.revenue)}` : `₹${e.revenue}`;
          const prod = e.product ? e.product : 'Sale'; // ✅ fallback when null
          return {
            time: hm(e.date),
            line: `${hm(e.date)} ${e.units > 0 ? e.units + "× " : ""}${prod} ${amt} (${tag})`
          };
        });

        const pageSize=sumView.pageSize||20;
        setSumView({context:'summary_detail',date:day,page:1,pageSize,rows});

        const total=rows.length;
        const totalPages=Math.max(1,Math.ceil(total/pageSize));
        const slice=rows.slice(0,pageSize);
        let out=`📜 ${L.LEDGER} — ${day} (Page 1/${totalPages}, ${pageSize}/page)\n`;
        if(!slice.length) out+='No transactions on this date.';
        slice.forEach((r,idx)=>{out+=`${idx+1}) ${r.line}\n`;});
        if(totalPages>1) out+=`Type: next / prev / page N`;
        return pushBot(out);
      }
      if((/^next$/i.test(text)||/^prev$/i.test(text)||/^page\s+\d+$/i.test(text)) && sumView.context==='summary_detail'){
        let {page,pageSize,rows,date}=sumView;
        const total=rows.length,totalPages=Math.max(1,Math.ceil(total/pageSize));
        if(/^next$/i.test(text)) page=Math.min(totalPages,page+1);
        if(/^prev$/i.test(text)) page=Math.max(1,page-1);
        const pm=text.match(/^page\s+(\d+)$/i); if(pm) page=Math.min(totalPages,Math.max(1,parseInt(pm[1],10)));
        setSumView({...sumView,page});
        const start=(page-1)*pageSize;
        const slice=rows.slice(start,start+pageSize);
        let out=`📜 ${L.LEDGER} — ${date} (Page ${page}/${totalPages}, ${pageSize}/page)\n`;
        slice.forEach((r,idx)=>{out+=`${start+idx+1}) ${r.line}\n`;});
        if(totalPages>1) out+=`Type: next / prev / page N`;
        return pushBot(out);
      }
    }

    if(subMode==='creditors'){
      setCreditorQuery(text);
      return pushBot(buildCreditorDetails(entries,text));
    }
    if(subMode==='payables'){
      setVendorQuery(text);
      return pushBot(buildPayableDetails(entries,text));
    }
  }

  async function handleSubmit(){
    if(!input.trim()) return;
    const t=input.trim();
    setInput('');
    await handleUserInput(t);
  }

  return (
    <div className="container">
      <div className="chat">
        {messages.map((m,i)=>(
          <ChatMessage key={i} sender={m.sender} text={m.text} ts={m.ts}/>
        ))}
      </div>

      <div className="input">
        <button onClick={()=>fileInputRef.current?.click()} title="Upload Invoice" aria-label="Upload Invoice">📎</button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf"
          style={{display:'none'}}
          onChange={(e)=>{const f=e.target.files?.[0]; if(f) handleInvoiceUpload(f); e.target.value='';}}
        />
        <input
          value={input}
          onChange={(e)=>setInput(e.target.value)}
          onKeyDown={(e)=>e.key==='Enter'&&handleSubmit()}
          placeholder={LABELS[uiLang].PLACEHOLDER(L)}
        />
        <button onClick={handleSubmit}>Send</button>
      </div>
    </div>
  );
}