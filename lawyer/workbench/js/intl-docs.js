/* =========================================================================
   intl-docs.js — 涉外双语文书：模板库 + 生成/编辑 + 法律翻译 + 认证指引 + 已生成
   -------------------------------------------------------------------------
   P0·高频。沿现有「文书管理」思路，加【语言】维度：中英双栏模板、生成、AI 翻译/润色、
   打印/复制导出、公证/认证/海牙认证指引。产出存本地（localStorage）。
   ========================================================================= */
(function () {
  var LS = { saved: "intl-docs.saved" };
  var now = function () { return new Date(); };
  var dateStr = function (d) { d = d || now(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
  var byId = function (id) { return document.getElementById(id); };

  // —— 双语文书模板库 ——
  // 2026-10 重写：原先是每篇 2~3 句的骨架，律师无法使用（"幼儿园小朋友写的"）。
  // 现在每篇都是**条款齐全的实务级文本**：定义 / 权利义务 / 例外 / 期限 /
  // 违约救济 / 适用法律与争议解决 / 其他条款，中英逐条对照。
  // {{变量}} 占位符由「变量填充」一键替换；改完仍是普通文本，律师可继续编辑。
  var TEMPLATES = [
    { id: "nda", name: "跨境保密协议", en: "Mutual Non-Disclosure Agreement",
      intro: "跨境商务、并购尽调、技术合作的前置保密安排。含定义、例外、不招揽、返还销毁、救济与准据法。",
      bodyCn: [
        "跨境保密协议",
        "甲方：{{甲方}}\n乙方：{{乙方}}",
        "鉴于甲乙双方拟就{{交易事项}}进行磋商，并可能相互披露保密信息，为明确双方的保密义务，经协商一致，达成如下协议：",
        "第一条 定义",
        "1.1 保密信息：指一方（下称披露方）以书面、口头、电子或其他任何形式向另一方（下称接收方）披露的、与磋商事项有关的全部非公开信息，包括但不限于技术资料、商业计划、客户与供应商名单、价格与成本数据、财务信息、合同文本及其条款，以及上述信息的载体、副本与衍生资料。",
        "1.2 保密信息不包括：(a) 披露时已属公知的信息；(b) 接收方在披露前已合法持有的信息；(c) 接收方从有权披露的第三方合法取得且不附带保密义务的信息；(d) 接收方未使用保密信息独立开发的信息；(e) 依法律、法规或司法机关、监管机构要求必须披露的信息（接收方应在法律允许的范围内事先书面通知披露方）。",
        "第二条 保密义务",
        "2.1 接收方应至少以保护自身同类信息的谨慎程度（且不低于合理谨慎）保护保密信息。",
        "2.2 接收方仅可为磋商{{交易事项}}之目的使用保密信息，不得用于任何其他目的。",
        "2.3 接收方仅可向其确有知悉必要的董事、管理人员、雇员及专业顾问（以下称代表）披露保密信息，并应促使该等代表承担不低于本协议标准的保密义务；接收方对其代表的行为承担责任。",
        "2.4 未经披露方事先书面同意，接收方不得复制、反向工程、公开披露或向第三方转让保密信息。",
        "第三条 不招揽",
        "在本协议有效期内及终止后{{不招揽期限}}内，接收方不得就与磋商事项实质相同的事项，直接或间接招揽、接触披露方的客户、供应商或雇员。",
        "第四条 返还或销毁",
        "磋商终止或经披露方书面要求时，接收方应在{{返还期限}}内返还或销毁全部保密信息（含所有副本与衍生资料），并向披露方书面确认。接收方为履行法律或内部合规义务必须留存的一份副本除外，该等留存副本仍受本协议约束。",
        "第五条 保密期限",
        "本协议自双方签署之日起生效，有效期{{期限}}。保密义务持续至该等信息进入公有领域或不再具有保密价值为止；对于构成商业秘密的信息，其保护期不受本协议期满的影响。",
        "第六条 违约救济",
        "接收方违反本协议给披露方造成损失的，应予赔偿，包括直接损失以及披露方为调查、制止违约行为而合理支出的律师费、公证费、差旅费。披露方有权另行申请禁令或其他衡平救济，且不影响其主张损害赔偿的权利。",
        "第七条 适用法律与争议解决",
        "7.1 本协议适用{{准据法}}。",
        "7.2 因本协议引起的或与之有关的任何争议，双方应先行友好协商；协商不成的，提交{{争议解决机构}}依其届时有效的仲裁规则解决。仲裁裁决为终局裁决，对双方均有约束力。",
        "7.3 本协议以中英文书就，两种文本具有同等效力；如两种文本存在歧义，以{{优先文本}}为准。",
        "第八条 其他",
        "8.1 本协议构成双方就保密事项的完整约定，取代此前所有口头或书面的沟通与承诺。",
        "8.2 本协议任何条款被认定为无效或不可执行，不影响其余条款的效力。",
        "8.3 未经另一方事先书面同意，任何一方不得转让本协议项下的权利或义务。",
        "（以下无正文，为签署页）",
        "甲方（盖章）：____________　　授权代表：____________　　日期：{{日期}}",
        "乙方（盖章）：____________　　授权代表：____________　　日期：{{日期}}"
      ],
      bodyEn: [
        "MUTUAL NON-DISCLOSURE AGREEMENT",
        "Party A: {{Party A}}\nParty B: {{Party B}}",
        "WHEREAS the Parties intend to discuss {{Transaction}} and may disclose confidential information to each other, the Parties hereby agree as follows to define their confidentiality obligations:",
        "Article 1 Definitions",
        "1.1 Confidential Information means all non-public information disclosed by one Party (the Disclosing Party) to the other (the Receiving Party) in written, oral, electronic or any other form in connection with the Discussions, including but not limited to technical data, business plans, customer and supplier lists, pricing and cost data, financial information, contract texts and terms, and all media, copies and derivative materials thereof.",
        "1.2 Confidential Information does not include: (a) information that is publicly known at the time of disclosure; (b) information lawfully held by the Receiving Party prior to disclosure; (c) information lawfully obtained from a third party entitled to disclose it without confidentiality obligations; (d) information independently developed by the Receiving Party without use of the Confidential Information; (e) information required to be disclosed by law, regulation, court or regulator (the Receiving Party shall, to the extent legally permitted, give prior written notice to the Disclosing Party).",
        "Article 2 Confidentiality Obligations",
        "2.1 The Receiving Party shall protect the Confidential Information with at least the same degree of care it uses for its own similar information, and in no event less than reasonable care.",
        "2.2 The Receiving Party shall use the Confidential Information solely for the purpose of the Discussions regarding {{Transaction}} and for no other purpose.",
        "2.3 The Receiving Party may disclose the Confidential Information only to its directors, officers, employees and professional advisers who have a bona fide need to know (the Representatives), and shall cause such Representatives to be bound by confidentiality obligations no less stringent than this Agreement. The Receiving Party shall be liable for the acts of its Representatives.",
        "2.4 The Receiving Party shall not copy, reverse engineer, publicly disclose or transfer the Confidential Information to any third party without the prior written consent of the Disclosing Party.",
        "Article 3 Non-Solicitation",
        "During the term of this Agreement and for {{Non-solicitation Period}} thereafter, the Receiving Party shall not, directly or indirectly, solicit or contact any customer, supplier or employee of the Disclosing Party in respect of any matter substantially similar to the Discussions.",
        "Article 4 Return or Destruction",
        "Upon termination of the Discussions or upon written request of the Disclosing Party, the Receiving Party shall, within {{Return Period}}, return or destroy all Confidential Information (including all copies and derivative materials) and confirm the same in writing. One copy may be retained solely to comply with legal or internal compliance obligations, and such retained copy shall remain subject to this Agreement.",
        "Article 5 Term",
        "This Agreement takes effect upon signature and remains valid for {{Term}}. The confidentiality obligations continue until the information enters the public domain or ceases to have confidential value. For information constituting a trade secret, the protection period shall not be affected by the expiry of this Agreement.",
        "Article 6 Remedies",
        "If the Receiving Party breaches this Agreement and causes loss to the Disclosing Party, it shall compensate such loss, including direct losses and reasonable attorneys fees, notarisation fees and travel expenses incurred in investigating and stopping the breach. The Disclosing Party may also seek injunctive or other equitable relief without prejudice to its claim for damages.",
        "Article 7 Governing Law and Dispute Resolution",
        "7.1 This Agreement is governed by {{Governing Law}}.",
        "7.2 Any dispute arising out of or in connection with this Agreement shall first be resolved through friendly negotiation. Failing such negotiation, the dispute shall be submitted to {{Arbitration Institution}} for arbitration under its arbitration rules in force at the time. The arbitral award shall be final and binding on both Parties.",
        "7.3 This Agreement is executed in Chinese and English, both texts being equally authentic. In case of ambiguity, the {{Prevailing Language}} text shall prevail.",
        "Article 8 Miscellaneous",
        "8.1 This Agreement constitutes the entire agreement between the Parties regarding confidentiality and supersedes all prior oral or written communications and undertakings.",
        "8.2 If any provision of this Agreement is held invalid or unenforceable, the validity of the remaining provisions shall not be affected.",
        "8.3 Neither Party may assign its rights or obligations under this Agreement without the prior written consent of the other Party.",
        "(No further text; signature page follows)",
        "Party A (seal): ____________  Authorised Signatory: ____________  Date: {{Date}}",
        "Party B (seal): ____________  Authorised Signatory: ____________  Date: {{Date}}"
      ] },

    { id: "poa", name: "授权委托书（域外使用）", en: "Power of Attorney (for use abroad)",
      intro: "涉外诉讼、仲裁、公证认证、境外事务代理的授权文件。含授权范围、转委托、有效期与撤销。",
      bodyCn: [
        "授权委托书",
        "委托人：{{甲方}}\n身份证件类型及号码：____________\n住所地／联系地址：____________\n联系电话：____________",
        "受托人：{{乙方}}\n执业机构：____________\n执业证号：____________\n联系电话：____________",
        "鉴于委托人需办理{{委托事项}}，现依据{{准据法}}的相关规定，特此授权如下：",
        "第一条 授权事项",
        "委托人兹委托受托人作为其代理人，办理下列事项：\n1. ____________；\n2. ____________；\n3. 与上述事项有关的其他必要事项。",
        "第二条 授权范围",
        "2.1 受托人有权代为下列行为：\n(a) 提交、签收、补正各类申请材料与法律文书；\n(b) 进行调查取证、查阅与复制案卷材料；\n(c) 参加庭审、听证、调解、谈判；\n(d) 代为承认、变更、放弃请求，进行和解；\n(e) 代为申请执行、签收执行款物；\n(f) 代为办理公证、认证及涉外文书的转递手续。",
        "2.2 前述授权为特别授权。受托人无权代为放弃委托人的实体权利，但经委托人另行书面确认的除外。",
        "第三条 转委托",
        "受托人可将部分事项转委托给其所在机构的其他执业人员办理，转委托的范围不得超过本委托书授权的范围，且受托人仍应就其行为向委托人负责。",
        "第四条 有效期",
        "本委托书自委托人签署之日起生效，有效期至{{期限}}或委托事项办理完毕之日（以较早者为准）。",
        "第五条 撤销与终止",
        "委托人有权随时书面通知撤销本委托书。撤销不影响撤销前受托人已实施的代理行为的效力。",
        "第六条 适用法律与争议解决",
        "本委托书适用{{准据法}}。因本委托书引起的争议，提交{{争议解决机构}}解决。",
        "第七条 其他",
        "7.1 本委托书以中英文书就；如用于境外，两种文本以{{优先文本}}为准，并按目的国要求办理公证与认证（领事认证或附加证明书 Apostille）。",
        "7.2 本委托书正本 ____ 份，交受托人 ____ 份，委托人留存 ____ 份，具有同等效力。",
        "委托人（签字）：____________　　日期：{{日期}}",
        "受托人（签字）：____________　　日期：{{日期}}",
        "【办理提示】用于域外时，通常需经公证机关公证；目的国为海牙公约成员国的，一般办理附加证明书（Apostille）即可，非成员国则需办理领事认证。具体要求以目的国主管机关规定为准。"
      ],
      bodyEn: [
        "POWER OF ATTORNEY",
        "Principal: {{Party A}}\nID type and number: ____________\nDomicile / Address: ____________\nTelephone: ____________",
        "Attorney: {{Party B}}\nLaw firm: ____________\nPractising certificate No.: ____________\nTelephone: ____________",
        "WHEREAS the Principal needs to handle {{Matters Authorised}}, the Principal hereby authorises the Attorney as follows pursuant to {{Governing Law}}:",
        "Article 1 Matters Authorised",
        "The Principal hereby appoints the Attorney as agent to handle the following matters:\n1. ____________;\n2. ____________;\n3. Such other matters as are necessary in connection with the foregoing.",
        "Article 2 Scope of Authority",
        "2.1 The Attorney is authorised to:\n(a) submit, receive and supplement applications and legal documents;\n(b) conduct investigation and evidence collection, and inspect and copy case files;\n(c) attend hearings, mediation and negotiations;\n(d) admit, vary or waive claims and enter into settlement;\n(e) apply for enforcement and receive enforcement proceeds;\n(f) handle notarisation, legalisation and transmission of foreign-related documents.",
        "2.2 The foregoing constitutes special authority. The Attorney may not waive the Principals substantive rights unless separately confirmed by the Principal in writing.",
        "Article 3 Delegation",
        "The Attorney may delegate part of the matters to other practitioners of the same firm, provided that the scope of delegation does not exceed the authority granted herein, and the Attorney shall remain responsible to the Principal for their acts.",
        "Article 4 Term",
        "This Power of Attorney takes effect upon signature and remains valid until {{Term}} or completion of the authorised matters, whichever is earlier.",
        "Article 5 Revocation and Termination",
        "The Principal may revoke this Power of Attorney at any time by written notice. Revocation shall not affect the validity of acts already performed by the Attorney prior to revocation.",
        "Article 6 Governing Law and Dispute Resolution",
        "This Power of Attorney is governed by {{Governing Law}}. Disputes arising hereunder shall be submitted to {{Arbitration Institution}}.",
        "Article 7 Miscellaneous",
        "7.1 This Power of Attorney is executed in Chinese and English. If used abroad, the {{Prevailing Language}} text shall prevail, and notarisation and legalisation (consular legalisation or Apostille) shall be obtained as required by the destination country.",
        "7.2 This Power of Attorney is made in ____ originals, ____ delivered to the Attorney and ____ retained by the Principal, all having equal effect.",
        "Principal (signature): ____________  Date: {{Date}}",
        "Attorney (signature): ____________  Date: {{Date}}",
        "[Note] For use abroad, notarisation is usually required. For contracting states to the Hague Apostille Convention, an Apostille generally suffices; otherwise consular legalisation is required. Specific requirements are subject to the competent authority of the destination country."
      ] },

    { id: "complaint", name: "涉外民事起诉状", en: "Foreign-related Civil Complaint",
      intro: "涉外民事一审起诉状。含当事人（含外方主体）信息、诉讼请求、事实与理由、管辖与法律适用依据、证据清单。",
      bodyCn: [
        "民事起诉状",
        "原告：{{甲方}}\n住所地：____________\n法定代表人／负责人：____________　职务：____________\n联系电话：____________",
        "被告：{{乙方}}\n住所地／注册地：____________\n法定代表人／负责人：____________\n联系电话：____________",
        "案由：{{案由}}",
        "诉讼请求",
        "一、判令被告____________；\n二、判令被告支付____________（币种及金额，暂计至 {{日期}}）；\n三、判令被告承担本案诉讼费用、保全费用及原告为实现债权支出的合理费用。",
        "事实与理由",
        "一、当事人之间的法律关系\n____年__月__日，原告与被告签订《____________》（下称合同），约定____________。合同第__条约定____________。",
        "二、合同履行情况\n原告已依约履行____________义务，被告仅履行____________，尚欠____________。",
        "三、被告的违约事实\n截至 {{日期}}，被告未按约履行____________，经原告于____年__月__日书面催告后仍未履行，已构成根本违约。",
        "四、原告的损失\n因被告违约，原告遭受损失共计____________，包括____________。",
        "五、管辖与法律适用依据",
        "5.1 本案系涉外民事案件。依据《中华人民共和国民事诉讼法》关于涉外民事诉讼程序的特别规定，以及合同第__条的管辖约定，贵院对本案享有管辖权。",
        "5.2 依据《中华人民共和国涉外民事关系法律适用法》第__条及合同第__条的约定，本案适用{{准据法}}。",
        "证据清单",
        "1. 合同及附件；2. 履行凭证（付款凭证／交付凭证／往来函件）；3. 催告函及送达凭证；4. 损失证明材料；5. 主体资格证明文件（境外主体须附经公证认证的注册证明及授权文件）；6. 其他。",
        "综上所述，被告的行为已构成违约，依法应承担相应责任。为维护原告合法权益，特依法提起诉讼，请求贵院依法裁判。",
        "此致",
        "____________人民法院",
        "具状人：{{甲方}}",
        "日期：{{日期}}",
        "附：1. 本起诉状副本 ____ 份；2. 证据材料 ____ 份；3. 原告主体资格证明 ____ 份。"
      ],
      bodyEn: [
        "CIVIL COMPLAINT",
        "Plaintiff: {{Party A}}\nDomicile: ____________\nLegal representative: ____________  Title: ____________\nTelephone: ____________",
        "Defendant: {{Party B}}\nDomicile / Registered address: ____________\nLegal representative: ____________\nTelephone: ____________",
        "Cause of action: {{Cause of Action}}",
        "CLAIMS",
        "1. Order the Defendant to ____________;\n2. Order the Defendant to pay ____________ (currency and amount, calculated up to {{Date}});\n3. Order the Defendant to bear the litigation costs, preservation costs and reasonable expenses incurred by the Plaintiff in enforcing its claims.",
        "FACTS AND GROUNDS",
        "I. Legal relationship between the parties\nOn __/__/____, the Plaintiff and the Defendant entered into the ____________ Agreement (the Contract), providing that ____________. Article __ of the Contract stipulates ____________.",
        "II. Performance of the Contract\nThe Plaintiff duly performed its obligation to ____________, while the Defendant only performed ____________ and remains in arrears of ____________.",
        "III. The Defendants breach\nAs of {{Date}}, the Defendant failed to perform ____________ as agreed. Despite written demand by the Plaintiff on __/__/____, the Defendant has not performed, constituting a fundamental breach.",
        "IV. Losses of the Plaintiff\nAs a result of the Defendants breach, the Plaintiff has suffered losses totalling ____________, including ____________.",
        "V. Jurisdiction and Applicable Law",
        "5.1 This is a foreign-related civil case. Pursuant to the special provisions on foreign-related civil procedure of the Civil Procedure Law of the PRC and the jurisdiction clause in Article __ of the Contract, this Court has jurisdiction over the case.",
        "5.2 Pursuant to Article __ of the Law of the PRC on the Application of Law to Foreign-related Civil Relations and Article __ of the Contract, {{Governing Law}} shall apply.",
        "LIST OF EVIDENCE",
        "1. Contract and annexes; 2. Performance evidence (payment/delivery records and correspondence); 3. Demand letter and proof of service; 4. Evidence of losses; 5. Certificates of legal status (foreign entities must attach notarised and legalised registration and authorisation documents); 6. Others.",
        "In conclusion, the Defendants conduct constitutes a breach of contract and it shall bear liability accordingly. To protect the Plaintiffs lawful rights and interests, this action is hereby brought before this Court for adjudication.",
        "Submitted to",
        "____________ Peoples Court",
        "Plaintiff: {{Party A}}",
        "Date: {{Date}}",
        "Attachments: 1. ____ copies of this Complaint; 2. ____ sets of evidence; 3. ____ certificates of the Plaintiffs legal status."
      ] },

    { id: "arb", name: "涉外仲裁申请书", en: "Application for Arbitration",
      intro: "国际商事仲裁申请书。含仲裁请求、事实与理由、仲裁协议与管辖依据、仲裁地／语言／庭组方式、证据。",
      bodyCn: [
        "仲裁申请书",
        "申请人：{{甲方}}\n住所地：____________\n法定代表人：____________\n联系电话：____________",
        "被申请人：{{乙方}}\n住所地／注册地：____________\n法定代表人：____________\n联系电话：____________",
        "一、仲裁请求",
        "1. 请求裁决被申请人向申请人支付____________；\n2. 请求裁决被申请人承担申请人为本案支出的仲裁费、律师费、保全费及其他合理费用；\n3. 其他请求：____________。",
        "二、事实与理由",
        "（一）合同关系与仲裁协议\n____年__月__日，申请人与被申请人签订《____________》（下称合同），合同第__条约定：因本合同引起的或与之有关的任何争议，提交{{争议解决机构}}依其仲裁规则仲裁解决。",
        "（二）履行与争议发生\n申请人已依约履行____________义务。被申请人未按约履行____________，经申请人多次催告仍未履行，双方争议由此产生。",
        "（三）法律依据\n被申请人的行为构成违约，依据合同第__条及{{准据法}}的相关规定，应承担继续履行、赔偿损失等违约责任。",
        "三、仲裁协议与管辖依据\n双方之间存在书面仲裁协议，仲裁事项属于{{争议解决机构}}仲裁规则规定的受理范围，该机构对本案享有管辖权。",
        "四、仲裁程序事项",
        "4.1 仲裁地：____________；\n4.2 仲裁语言：____________；\n4.3 仲裁庭组成：____ 名仲裁员（独任／三人）；\n4.4 仲裁规则：{{争议解决机构}}届时有效的仲裁规则。",
        "五、证据清单",
        "1. 合同及附件；2. 履行凭证；3. 催告与往来函件；4. 损失证明材料；5. 主体资格与授权文件；6. 其他。",
        "综上所述，申请人的仲裁请求具有事实与法律依据，恳请仲裁庭依法支持申请人的全部仲裁请求。",
        "此致",
        "{{争议解决机构}}",
        "申请人：{{甲方}}",
        "日期：{{日期}}"
      ],
      bodyEn: [
        "APPLICATION FOR ARBITRATION",
        "Claimant: {{Party A}}\nDomicile: ____________\nLegal representative: ____________\nTelephone: ____________",
        "Respondent: {{Party B}}\nDomicile / Registered address: ____________\nLegal representative: ____________\nTelephone: ____________",
        "I. ARBITRATION CLAIMS",
        "1. Order the Respondent to pay the Claimant ____________;\n2. Order the Respondent to bear the arbitration fees, attorneys fees, preservation fees and other reasonable expenses incurred by the Claimant in this case;\n3. Other claims: ____________.",
        "II. FACTS AND GROUNDS",
        "(1) Contractual relationship and arbitration agreement\nOn __/__/____, the Claimant and the Respondent entered into the ____________ Agreement (the Contract). Article __ of the Contract provides that any dispute arising out of or in connection with the Contract shall be submitted to {{Arbitration Institution}} for arbitration under its arbitration rules.",
        "(2) Performance and the dispute\ncThe Claimant has duly performed its obligation to ____________. The Respondent failed to perform ____________ as agreed and has not performed despite repeated demands, giving rise to the present dispute.",
        "(3) Legal basis\nThe Respondents conduct constitutes a breach of contract. Pursuant to Article __ of the Contract and {{Governing Law}}, the Respondent shall bear liability for specific performance and damages.",
        "III. ARBITRATION AGREEMENT AND JURISDICTION",
        "A written arbitration agreement exists between the Parties. The dispute falls within the scope of matters acceptable under the arbitration rules of {{Arbitration Institution}}, which has jurisdiction over this case.",
        "IV. PROCEDURAL MATTERS",
        "4.1 Seat of arbitration: ____________;\n4.2 Language of arbitration: ____________;\n4.3 Composition of the tribunal: ____ arbitrator(s) (sole / three);\n4.4 Arbitration rules: the arbitration rules of {{Arbitration Institution}} in force at the relevant time.",
        "V. LIST OF EVIDENCE",
        "1. Contract and annexes; 2. Performance evidence; 3. Demand and correspondence; 4. Evidence of losses; 5. Certificates of legal status and authorisation; 6. Others.",
        "In conclusion, the Claimants claims are well founded in fact and in law. The Claimant respectfully requests the Tribunal to grant all of its claims.",
        "Submitted to",
        "{{Arbitration Institution}}",
        "Claimant: {{Party A}}",
        "Date: {{Date}}"
      ] },

    { id: "opinion", name: "涉外法律意见书", en: "Legal Opinion",
      intro: "涉外交易、投资、合规事项的法律意见书。含审阅文件、假设与限定、逐项法律分析、结论与声明。",
      bodyCn: [
        "法律意见书",
        "致：{{甲方}}",
        "事由：关于{{交易事项}}的法律意见",
        "一、引言",
        "我们接受委托，就{{交易事项}}所涉法律问题出具本法律意见书。本意见书仅供委托人____________之目的使用，未经我们事先书面同意，不得用于其他目的或提供给任何第三方。",
        "二、已审阅的文件与事实基础",
        "1. 《____________》；\n2. ____________；\n3. 我们向委托人有关人员所作的询问及取得的说明。",
        "三、假设与限定",
        "3.1 我们假设：所审阅文件的签字与印章真实、文件原件与副本一致、复印件与原件一致，且文件所载事实真实、准确、完整。",
        "3.2 我们对事实的核查仅限于前述文件与说明；我们未对____________进行独立核查。",
        "3.3 本意见书仅就{{准据法}}发表意见，不对其他法域的法律发表意见。",
        "四、法律分析",
        "4.1 主体资格与授权\n经核查，{{甲方}}为依其注册地法律有效设立并有效存续的主体；签署本交易文件已获得必要的内部授权。",
        "4.2 交易文件的效力\n本交易文件的形式与内容不违反{{准据法}}的强制性规定，在满足____________条件后即对各方产生约束力。",
        "4.3 合规事项\n本次交易涉及____________（如需办理境外投资备案／反垄断申报／行业许可／数据出境安全评估等），应于____________之前完成。",
        "4.4 税务事项\n本次交易可能涉及的税种包括____________；具体税负以主管税务机关的认定为准，建议在交割前取得税务专业意见。",
        "4.5 争议解决\n交易文件约定的争议解决方式为____________，其裁决／判决在____________的可执行性受____________影响。",
        "五、结论",
        "基于上述假设与限定，我们认为：____________。",
        "六、声明与保留",
        "6.1 本意见书基于出具日有效的法律法规及我们于该日知悉的事实作出；此后法律法规变化或事实变化可能导致本意见不再适用，我们不承担更新义务。",
        "6.2 本意见书不构成对交易商业可行性、财务可行性或税务结果的保证，亦不构成对任何第三方的主张或抗辩的承诺。",
        "6.3 本意见书中「我们认为」等表述，系指我们依据专业判断给出的法律意见，不构成对事实的确认。",
        "____________律师事务所（盖章）",
        "经办律师：____________　执业证号：____________",
        "日期：{{日期}}"
      ],
      bodyEn: [
        "LEGAL OPINION",
        "To: {{Party A}}",
        "Re: Legal opinion on {{Transaction}}",
        "I. INTRODUCTION",
        "We have been instructed to render this legal opinion on the legal issues arising from {{Transaction}}. This opinion is furnished solely for the purpose of ____________ and may not be used for any other purpose or provided to any third party without our prior written consent.",
        "II. DOCUMENTS REVIEWED AND FACTUAL BASIS",
        "1. ____________;\n2. ____________;\n3. Enquiries made to and explanations obtained from the personnel of the Client.",
        "III. ASSUMPTIONS AND QUALIFICATIONS",
        "3.1 We have assumed that: the signatures and seals on the documents reviewed are genuine, originals and copies are consistent, and the facts stated therein are true, accurate and complete.",
        "3.2 Our verification of facts is limited to the documents and explanations referred to above; we have not independently verified ____________.",
        "3.3 This opinion addresses only {{Governing Law}} and we express no opinion on the laws of any other jurisdiction.",
        "IV. LEGAL ANALYSIS",
        "4.1 Status and authority\nBased on our review, {{Party A}} is validly incorporated and validly existing under the laws of its place of incorporation, and has obtained the necessary internal authorisation to execute the transaction documents.",
        "4.2 Validity of the transaction documents\nThe form and content of the transaction documents do not contravene the mandatory provisions of {{Governing Law}} and, upon satisfaction of ____________, will be binding on the parties.",
        "4.3 Compliance matters\nThis transaction involves ____________ (e.g. outbound investment filing, merger control notification, industry licence, security assessment for outbound data transfer), which should be completed before ____________.",
        "4.4 Tax matters\nTaxes potentially involved include ____________. The actual tax liability is subject to the determination of the competent tax authority; separate tax advice should be obtained before closing.",
        "4.5 Dispute resolution\nThe dispute resolution mechanism agreed in the transaction documents is ____________, and the enforceability of awards/judgments in ____________ is affected by ____________.",
        "V. CONCLUSION",
        "Subject to the foregoing assumptions and qualifications, we are of the opinion that ____________.",
        "VI. STATEMENTS AND RESERVATIONS",
        "6.1 This opinion is given on the basis of the laws and regulations in force and the facts known to us as at the date hereof. Subsequent changes in law or fact may render it inapplicable and we assume no obligation to update it.",
        "6.2 This opinion does not constitute a warranty of the commercial or financial feasibility of the transaction or of tax outcomes, nor an undertaking as to any third partys claims or defences.",
        "6.3 Expressions such as we are of the opinion reflect our legal judgement based on professional analysis and do not constitute confirmation of facts.",
        "____________ Law Firm (seal)",
        "Handling lawyer: ____________  Practising certificate No.: ____________",
        "Date: {{Date}}"
      ] },

    { id: "guarantee", name: "跨境担保函", en: "Cross-border Letter of Guarantee",
      intro: "跨境交易、融资、履约的担保文件。含主债务、担保范围、担保方式、担保期间、陈述保证与准据法。",
      bodyCn: [
        "担 保 函",
        "致：{{乙方}}（下称债权人）",
        "担保人：{{甲方}}\n住所地：____________\n法定代表人：____________",
        "鉴于债权人与____________（下称债务人）于____年__月__日签订《____________》（下称主合同），担保人应债务人请求，就债务人在主合同项下的债务向债权人提供担保。担保人特此承诺如下：",
        "第一条 主债务",
        "本担保函担保的主债务为债务人在主合同项下应向债权人支付的____________，本金金额不超过____________（币种：________），以及相应的利息、违约金、损害赔偿金。",
        "第二条 担保范围",
        "担保范围包括：主债务本金、利息、罚息、违约金、损害赔偿金，以及债权人实现债权与担保权利而发生的合理费用（包括但不限于律师费、诉讼／仲裁费、保全费、公证费、执行费、差旅费）。",
        "第三条 担保方式",
        "3.1 担保人提供连带责任保证。主债务履行期限届满债务人未履行或未完全履行主债务的，债权人有权直接要求担保人在担保范围内承担担保责任。",
        "3.2 债权人就主债务享有的其他担保（如有）不影响本担保函项下担保责任的承担；债权人有权选择行使任一担保权利，无须先就其他担保主张权利。",
        "第四条 担保期间",
        "本担保函项下的保证期间为{{期限}}，自主债务履行期限届满之日起算。担保人已在担保期间届满前被要求承担担保责任的，保证责任不因担保期间的届满而免除。",
        "第五条 主合同的变更",
        "债权人与债务人协议变更主合同，加重主债务的，应事先取得担保人书面同意；未经同意，担保人对加重部分不承担担保责任。",
        "第六条 陈述与保证",
        "6.1 担保人为依其注册地法律有效设立并有效存续的主体，具有提供本担保的完全行为能力与授权。",
        "6.2 担保人签署与履行本担保函不违反其公司章程、所适用的法律或其作为一方的任何协议。",
        "6.3 担保人不存在可能严重影响其履约能力的未披露重大诉讼、仲裁、行政处罚或债务违约情形。",
        "第七条 适用法律与争议解决",
        "本担保函适用{{准据法}}。因本担保函引起的或与之有关的争议，提交{{争议解决机构}}解决。",
        "第八条 其他",
        "8.1 本担保函为独立于主合同的文件，主合同无效不影响本担保函的效力。",
        "8.2 本担保函以中英文书就；如两种文本存在歧义，以{{优先文本}}为准。",
        "担保人（盖章）：____________　　授权代表：____________　　日期：{{日期}}"
      ],
      bodyEn: [
        "LETTER OF GUARANTEE",
        "To: {{Party B}} (the Creditor)",
        "Guarantor: {{Party A}}\nDomicile: ____________\nLegal representative: ____________",
        "WHEREAS the Creditor and ____________ (the Debtor) entered into the ____________ Agreement (the Principal Contract) on __/__/____, the Guarantor, at the request of the Debtor, hereby guarantees the Debtors obligations under the Principal Contract and undertakes as follows:",
        "Article 1 Principal Obligations",
        "The principal obligations guaranteed hereunder are the ____________ payable by the Debtor to the Creditor under the Principal Contract, with a principal amount not exceeding ____________ (currency: ________), together with interest and liquidated damages thereon.",
        "Article 2 Scope of Guarantee",
        "The scope of guarantee covers the principal amount, interest, default interest, liquidated damages, damages, and reasonable expenses incurred by the Creditor in enforcing its claims and security rights (including but not limited to attorneys fees, litigation/arbitration costs, preservation fees, notarisation fees, enforcement fees and travel expenses).",
        "Article 3 Form of Guarantee",
        "3.1 The Guarantor provides a joint and several guarantee. If the Debtor fails to perform or fully perform the principal obligations upon expiry of the performance period, the Creditor may require the Guarantor to assume guarantee liability within the scope of the guarantee directly.",
        "3.2 Any other security held by the Creditor in respect of the principal obligations (if any) shall not affect the guarantee liability hereunder. The Creditor may enforce any security at its discretion without first enforcing other security.",
        "Article 4 Guarantee Period",
        "The guarantee period hereunder is {{Term}}, commencing from the expiry of the performance period of the principal obligations. Where the Guarantor is required to assume guarantee liability before expiry of the guarantee period, such liability shall not be discharged by the subsequent expiry of the guarantee period.",
        "Article 5 Amendment of the Principal Contract",
        "Where the Creditor and the Debtor agree to amend the Principal Contract and thereby increase the principal obligations, the prior written consent of the Guarantor shall be obtained; absent such consent, the Guarantor shall not be liable for the increased portion.",
        "Article 6 Representations and Warranties",
        "6.1 The Guarantor is validly incorporated and validly existing under the laws of its place of incorporation, with full capacity and authority to provide this guarantee.",
        "6.2 The execution and performance of this guarantee do not violate its articles of association, applicable laws or any agreement to which it is a party.",
        "6.3 There is no undisclosed material litigation, arbitration, administrative penalty or payment default that may materially affect the Guarantors ability to perform.",
        "Article 7 Governing Law and Dispute Resolution",
        "This guarantee is governed by {{Governing Law}}. Disputes arising out of or in connection with this guarantee shall be submitted to {{Arbitration Institution}}.",
        "Article 8 Miscellaneous",
        "8.1 This guarantee is a document independent of the Principal Contract, and the invalidity of the Principal Contract shall not affect the validity of this guarantee.",
        "8.2 This guarantee is executed in Chinese and English. In case of ambiguity, the {{Prevailing Language}} text shall prevail.",
        "Guarantor (seal): ____________  Authorised Signatory: ____________  Date: {{Date}}"
      ] },

    { id: "loi", name: "跨境股权收购意向书（LOI）", en: "Letter of Intent for Cross-border Share Acquisition",
      intro: "跨境并购前期意向书。含交易结构、估值与对价、先决条件、排他期、费用与保密，明确非约束力条款。",
      bodyCn: [
        "股权收购意向书（Letter of Intent）",
        "甲方（受让方）：{{甲方}}\n乙方（转让方）：{{乙方}}",
        "鉴于：\n1. 乙方持有{{交易事项}}（以下称目标公司）____% 的股权；\n2. 甲方拟受让乙方持有的目标公司股权（下称本次交易）；\n为推进本次交易，双方达成如下意向：",
        "第一条 交易结构",
        "1.1 甲方拟以____________方式受让目标公司____% 股权。\n1.2 交易完成后，甲方持有目标公司____% 股权，目标公司股权结构为：____________。\n1.3 交割方式：____________。",
        "第二条 估值与对价",
        "2.1 双方初步商定目标公司整体估值为____________（币种：________），以____________为基础确定（如：经审计的净利润／EBITDA 倍数）。\n2.2 对价支付安排：____________；其中 ____% 作为业绩承诺／交割后调整的保证金。\n2.3 最终估值与对价以双方签署的正式收购协议为准。",
        "第三条 先决条件",
        "本次交易的交割以下列条件全部满足为前提：\n1. 完成法律、财务、税务尽职调查且结果令甲方满意；\n2. 取得必要的内部与外部批准（含反垄断申报、境外投资备案、行业许可等）；\n3. 目标公司核心人员签署留任协议；\n4. 其他：____________。",
        "第四条 排他期",
        "自本意向书签署之日起{{期限}}内，乙方及其关联方不得就目标公司股权或实质资产的转让，与任何第三方进行接触、磋商或签署协议。",
        "第五条 尽职调查",
        "在排他期内，甲方有权对目标公司开展法律、财务、税务及业务尽职调查，乙方应提供必要的配合与资料。甲方对调查中获知的信息承担保密义务。",
        "第六条 保密",
        "双方对本意向书的内容及磋商过程承担保密义务，除法律要求或事先书面同意外，不得向第三方披露。",
        "第七条 费用",
        "除另有约定外，各方自行承担因本次交易发生的费用（包括中介机构费用）。",
        "第八条 法律效力",
        "8.1 除第四条（排他期）、第六条（保密）、第七条（费用）、第八条（法律效力）及争议解决条款外，本意向书不构成具有法律约束力的合同；双方的权利义务以正式收购协议为准。\n8.2 本意向书适用{{准据法}}；因本意向书产生的争议提交{{争议解决机构}}解决。",
        "第九条 有效期",
        "本意向书自双方签署之日起生效，有效期{{期限}}。期限届满未签署正式收购协议的，本意向书自动终止。",
        "甲方（盖章）：____________　　授权代表：____________　　日期：{{日期}}",
        "乙方（盖章）：____________　　授权代表：____________　　日期：{{日期}}"
      ],
      bodyEn: [
        "LETTER OF INTENT FOR SHARE ACQUISITION",
        "Party A (Transferee): {{Party A}}\nParty B (Transferor): {{Party B}}",
        "WHEREAS:\n1. Party B holds ____% of the equity interest in {{Transaction}} (the Target Company);\n2. Party A intends to acquire the equity interest held by Party B in the Target Company (the Transaction);\nthe Parties have reached the following understanding to advance the Transaction:",
        "Article 1 Transaction Structure",
        "1.1 Party A intends to acquire ____% of the equity interest in the Target Company by way of ____________.\n1.2 Upon completion, Party A will hold ____% of the equity interest in the Target Company, and the shareholding structure will be: ____________.\n1.3 Closing mechanism: ____________.",
        "Article 2 Valuation and Consideration",
        "2.1 The Parties preliminarily agree an enterprise valuation of the Target Company of ____________ (currency: ________), determined on the basis of ____________ (e.g. audited net profit / EBITDA multiple).\n2.2 Payment arrangement: ____________, of which ____% shall serve as security for performance commitments or post-closing adjustments.\n2.3 The final valuation and consideration shall be subject to the definitive acquisition agreement.",
        "Article 3 Conditions Precedent",
        "Closing is conditional upon satisfaction of all of the following:\n1. Completion of legal, financial and tax due diligence to Party As satisfaction;\n2. Obtaining necessary internal and external approvals (including merger control filing, outbound investment filing, industry licences, etc.);\n3. Execution of retention agreements by key personnel of the Target Company;\n4. Others: ____________.",
        "Article 4 Exclusivity",
        "Within {{Term}} from the date of this LOI, Party B and its affiliates shall not contact, negotiate with or enter into agreements with any third party regarding the transfer of equity interest in, or material assets of, the Target Company.",
        "Article 5 Due Diligence",
        "During the exclusivity period, Party A is entitled to conduct legal, financial, tax and business due diligence on the Target Company, and Party B shall provide necessary cooperation and information. Party A shall keep information obtained confidential.",
        "Article 6 Confidentiality",
        "The Parties shall keep the contents of this LOI and the negotiation process confidential and shall not disclose them to third parties except as required by law or with prior written consent.",
        "Article 7 Expenses",
        "Unless otherwise agreed, each Party shall bear its own costs (including adviser fees) incurred in connection with the Transaction.",
        "Article 8 Legal Effect",
        "8.1 Except for Article 4 (Exclusivity), Article 6 (Confidentiality), Article 7 (Expenses), Article 8 (Legal Effect) and the dispute resolution provision, this LOI does not constitute a legally binding contract; the rights and obligations of the Parties shall be governed by the definitive acquisition agreement.\n8.2 This LOI is governed by {{Governing Law}}. Disputes arising hereunder shall be submitted to {{Arbitration Institution}}.",
        "Article 9 Term",
        "This LOI takes effect upon signature and remains valid for {{Term}}. If no definitive acquisition agreement is signed within such period, this LOI shall automatically terminate.",
        "Party A (seal): ____________  Authorised Signatory: ____________  Date: {{Date}}",
        "Party B (seal): ____________  Authorised Signatory: ____________  Date: {{Date}}"
      ] },

    { id: "data", name: "数据出境合规承诺函", en: "Undertaking on Compliance of Outbound Data Transfer",
      intro: "涉数据出境业务的合规承诺文件。含数据范围、合法性基础、安全措施、接收方约束、事件响应与承诺事项。",
      bodyCn: [
        "数据出境合规承诺函",
        "致：{{乙方}}",
        "承诺人：{{甲方}}\n住所地：____________\n统一社会信用代码／注册号：____________",
        "鉴于承诺人与贵方拟就{{交易事项}}开展合作，合作过程中可能涉及数据出境。承诺人现就数据出境合规事项作出如下承诺：",
        "第一条 数据出境的范围",
        "1.1 本次涉及出境的数据包括：____________（如：客户姓名、联系方式、订单信息、设备标识等）。\n1.2 其中属于个人信息的有：____________；属于敏感个人信息的有：____________（如无，填写无）。\n1.3 数据出境的目的：____________；方式：____________；接收方及所在国家／地区：____________。",
        "第二条 合法性基础",
        "2.1 承诺人已依据《中华人民共和国个人信息保护法》《数据出境安全评估办法》及相关规定，履行下列一项或多项程序：\n(a) 通过国家网信部门组织的安全评估；\n(b) 经专业机构进行个人信息保护认证；\n(c) 与境外接收方订立符合规定的标准合同并完成备案；\n(d) 取得个人的单独同意（涉及敏感个人信息或法定情形时）。",
        "2.2 承诺人已就数据出境事项向相关个人履行告知义务，告知内容真实、准确、完整。",
        "第三条 安全保护措施",
        "3.1 承诺人对出境数据采取加密传输、访问控制、最小必要授权、留存审计日志等技术与管理措施。\n3.2 承诺人建立数据出境台账，记录出境时间、数据种类、数量、接收方及用途，保存期限不少于____年。",
        "第四条 对境外接收方的约束",
        "承诺人已或将以合同等方式要求境外接收方：\n(a) 仅按约定目的处理数据；\n(b) 采取不低于本函要求的安全措施；\n(c) 未经承诺人同意不得转委托或再转移；\n(d) 在数据主体依法律行使权利时予以配合；\n(e) 约定终止后的数据删除或返还义务。",
        "第五条 安全事件响应",
        "发生或可能发生数据泄露、篡改、丢失等安全事件时，承诺人应于知悉后____小时内通知贵方，并配合采取补救措施；依法需向监管部门与个人告知的，承诺人负责履行告知义务。",
        "第六条 承诺事项",
        "承诺人承诺：\n1. 所提供的数据来源合法，已取得必要授权；\n2. 不超出约定目的与范围处理数据；\n3. 不将数据用于约定之外的目的或提供给约定之外的第三方；\n4. 因承诺人违反上述承诺给贵方或数据主体造成损失的，由承诺人承担相应责任。",
        "第七条 适用法律与争议解决",
        "本函适用{{准据法}}。因本函引起的争议，提交{{争议解决机构}}解决。",
        "承诺人（盖章）：____________　　授权代表：____________　　日期：{{日期}}",
        "【合规提示】数据出境的具体路径（安全评估／标准合同／保护认证）取决于数据种类、数量与接收方所在国家或地区，请在实施前对照最新规定确认，并留存相应的申报或备案凭证。"
      ],
      bodyEn: [
        "UNDERTAKING ON COMPLIANCE OF OUTBOUND DATA TRANSFER",
        "To: {{Party B}}",
        "Undertaking Party: {{Party A}}\nDomicile: ____________\nUnified Social Credit Code / Registration No.: ____________",
        "WHEREAS the Undertaking Party and you intend to cooperate on {{Transaction}}, which may involve outbound data transfer, the Undertaking Party hereby undertakes as follows in respect of compliance of such transfer:",
        "Article 1 Scope of Outbound Data",
        "1.1 The data involved in this outbound transfer includes: ____________ (e.g. customer name, contact details, order information, device identifiers).\n1.2 Personal information included: ____________; sensitive personal information included: ____________ (state none if not applicable).\n1.3 Purpose of transfer: ____________; method: ____________; recipient and country/region: ____________.",
        "Article 2 Lawful Basis",
        "2.1 The Undertaking Party has, in accordance with the Personal Information Protection Law of the PRC, the Measures for Security Assessment of Outbound Data Transfer and relevant provisions, completed one or more of the following:\n(a) passed the security assessment organised by the national cyberspace administration;\n(b) obtained personal information protection certification from a qualified institution;\n(c) entered into a compliant standard contract with the overseas recipient and completed filing;\n(d) obtained separate consent of the individuals (where sensitive personal information or statutory circumstances are involved).",
        "2.2 The Undertaking Party has fulfilled its notification obligations to the relevant individuals regarding the outbound transfer, and the notified content is true, accurate and complete.",
        "Article 3 Security Measures",
        "3.1 The Undertaking Party adopts technical and managerial measures for the outbound data, including encrypted transmission, access control, least-privilege authorisation and audit logs.\n3.2 The Undertaking Party maintains a register of outbound data recording time, categories, volume, recipients and purposes, retained for no less than ____ years.",
        "Article 4 Obligations on the Overseas Recipient",
        "The Undertaking Party has required or will require the overseas recipient by contract or otherwise to:\n(a) process the data only for the agreed purposes;\n(b) adopt security measures no less stringent than those required herein;\n(c) refrain from sub-delegation or further transfer without the Undertaking Partys consent;\n(d) assist data subjects in exercising their rights under applicable law;\n(e) delete or return the data upon termination as agreed.",
        "Article 5 Incident Response",
        "Upon occurrence or likely occurrence of data breach, tampering or loss, the Undertaking Party shall notify you within ____ hours of becoming aware and cooperate in remedial measures. Where notification to regulators and individuals is required by law, the Undertaking Party shall be responsible for such notification.",
        "Article 6 Undertakings",
        "The Undertaking Party undertakes:\n1. the data provided is lawfully sourced and necessary authorisations have been obtained;\n2. not to process the data beyond the agreed purpose and scope;\n3. not to use the data for purposes other than agreed or provide it to third parties other than as agreed;\n4. to bear corresponding liability for losses caused to you or data subjects by breach of the foregoing.",
        "Article 7 Governing Law and Dispute Resolution",
        "This Undertaking is governed by {{Governing Law}}. Disputes arising hereunder shall be submitted to {{Arbitration Institution}}.",
        "Undertaking Party (seal): ____________  Authorised Signatory: ____________  Date: {{Date}}",
        "[Note] The applicable route for outbound data transfer (security assessment / standard contract / protection certification) depends on the categories and volume of data and the recipients jurisdiction. Please confirm against the latest rules before implementation and retain the relevant filing or assessment records."
      ] },
  ];

  // —— 认证/公证/海牙认证指引（参考） ——
  var CERT_GUIDE = [
    { k: "notary", t: "公证", d: "境内文件涉外公证书：由公证处办理，确认签名/印鉴/文件真实性。" },
    { k: "legalize", t: "领事认证", d: "公证书外交部或地方外办认证目的国驻华使领馆认证（适用非海牙公约成员）。" },
    { k: "apostille", t: "海牙认证(Apostille)", d: "中国已加入《取消外国公文书认证要求的公约》(海牙公约)，部分文件仅需附加证明书(Apostille)，免领事认证。" },
    { k: "dual", t: "中英对照", d: "涉外文件建议中英对照并公证翻译；术语一致、份数/份数核对。" },
  ];

  // —— 自有模板（律师上传的本所模板；只存本机 localStorage，不上传）——
  var USER_TPL_KEY = "legal-mode.intl.userTemplates";
  function loadUserTpls() { try { return JSON.parse(localStorage.getItem(USER_TPL_KEY) || "[]"); } catch (e) { return []; } }
  function saveUserTpls() { try { localStorage.setItem(USER_TPL_KEY, JSON.stringify(userTpls)); } catch (e) { } }
  var userTpls = loadUserTpls();

  var state = { tab: "library", current: null, mode: "cn" };
  /**
   * 「查看原文」的状态（对齐鸿蒙端）。
   * - openTplId：同一时刻只展开一个模板的原文（手风琴），空串为全收起
   * - origLang：原文看的是中文还是英文 —— 中文正文动辄上千字，会把英文顶到
   *   十几屏之外，光加提示解决不了「看不到」。切换后每种语言各占一屏。
   * 注：卡片上那行外文名（如 Mutual Non-Disclosure Agreement）只是**模板名**，
   * 不是译文 —— 这是用户最容易误解的地方。
   */
  var openTplId = "";
  var origLang = "cn";

  /**
   * 应用原文语言：切换正文显示 + 更新中英按钮选中态。
   * ⚠️ 只改 DOM，不重新 render —— render 会重建 innerHTML，把用户在
   * 「生成 / 编辑」里已经改过的正文冲掉（切 tab 也是走同一套 DOM-only 逻辑）。
   */
  function applyOrigLang(container) {
    container.querySelectorAll("[data-origbody]").forEach(function (d) {
      d.style.display = (d.getAttribute("data-origbody") === origLang) ? "block" : "none";
    });
    container.querySelectorAll("[data-origlang]").forEach(function (b) {
      var on = b.getAttribute("data-origlang") === origLang;
      b.className = "btn btn-sm " + (on ? "btn-primary" : "btn-ghost");
    });
  }

  /**
   * 生成类按钮的单选态（点一个亮一个；再点同一个取消）。
   * ⚠️ 只改 DOM class，不重新 render —— render 会重建 innerHTML 把用户已编辑的正文冲掉。
   */
  var activeAction = "";
  function markActive(container, key) {
    activeAction = (activeAction === key) ? "" : key;
    container.querySelectorAll("[data-act]").forEach(function (b) {
      var on = b.getAttribute("data-act") === activeAction;
      b.classList.toggle("btn-primary", on);
      b.classList.toggle("btn-ghost", !on);
    });
  }
  // —— 术语一致性校验（2026-10 新增）——
  // 涉外律师真正的时间黑洞不是「查法规」（官方平台已免费提供），而是**双语合同里
  // 同一个中文术语被译成好几种英文**——「保密协议」一会儿 NDA、一会儿 confidentiality
  // agreement；「不可抗力」一会儿 force majeure、一会儿 act of God。这类不一致在争议
  // 发生时会被对方拿来做条款解释的突破口，而它恰恰是**纯本地就能查出来的**：
  // 不联网、不调 AI、不需要任何外部数据。这就是本模块的卖点：官方给「资料」，我们给「检查」。
  //
  // 诚实边界：这是**关键词级**比对，不是句法级 NLP。能抓漏译与译法不统一，
  // 不能替代专业审校；界面上必须如实这么写。
  var TERM_PAIRS = [
    { cn: "保密协议", en: "non-disclosure agreement", alts: ["nda", "confidentiality agreement"] },
    { cn: "违约责任", en: "liability for breach", alts: ["breach liability", "default liability"] },
    { cn: "不可抗力", en: "force majeure", alts: ["act of god"] },
    { cn: "准据法", en: "governing law", alts: ["applicable law", "proper law"] },
    { cn: "争议解决", en: "dispute resolution", alts: ["settlement of disputes"] },
    { cn: "仲裁裁决", en: "arbitral award", alts: ["arbitration award"] },
    { cn: "承认与执行", en: "recognition and enforcement", alts: ["recognition & enforcement"] },
    { cn: "管辖法院", en: "competent court", alts: ["court of jurisdiction"] },
    { cn: "赔偿", en: "indemnity", alts: ["compensation", "damages"] },
    { cn: "陈述与保证", en: "representations and warranties", alts: ["representations & warranties"] },
    { cn: "生效条件", en: "conditions precedent", alts: ["effectiveness conditions"] },
    { cn: "终止", en: "termination", alts: ["cancellation"] },
    { cn: "转让", en: "assignment", alts: ["transfer", "cession"] },
    { cn: "知识产权", en: "intellectual property", alts: ["ip rights"] },
    { cn: "尽职调查", en: "due diligence", alts: [] },
    { cn: "交割", en: "closing", alts: ["completion"] },
    { cn: "排他性", en: "exclusivity", alts: ["exclusive"] },
    { cn: "完整协议", en: "entire agreement", alts: ["whole agreement"] },
    { cn: "可分割性", en: "severability", alts: ["separability"] },
    { cn: "弃权", en: "waiver", alts: [] },
  ];

  /**
   * 术语一致性校验：三类问题
   *   ① 漏译   —— 中文出现该术语，译文里连推荐译法都没有；
   *   ② 不统一 —— 推荐译法与某个变体同时出现（同一术语两种译法）；
   *   ③ 非标准 —— 只用了变体、没用推荐译法。
   */
  /** 截取命中词周围一小段原文，命中处用【】框出（让用户在长文里一眼找到位置） */
  function termExcerpt(text, seek) {
    var t = String(text || "").trim();
    var at = t.toLowerCase().indexOf(seek);
    if (at < 0) return t.length > 90 ? t.slice(0, 90) + "…" : t;
    var start = at > 30 ? at - 30 : 0;
    var end = at + seek.length;
    var tailEnd = Math.min(end + 30, t.length);
    return (start > 0 ? "…" : "") + t.slice(start, at) + "【" + t.slice(at, end) + "】"
      + t.slice(end, tailEnd) + (tailEnd < t.length ? "…" : "");
  }

  /** 把英文正文里所有命中词标上【】，生成「标注版」全文 */
  function buildMarked(en, marks) {
    var out = String(en || "");
    marks.forEach(function (m) {
      if (!m) return;
      var idx = out.toLowerCase().indexOf(m.toLowerCase()), guard = 0;
      while (idx >= 0 && guard < 40) {
        out = out.slice(0, idx) + "【" + out.slice(idx, idx + m.length) + "】" + out.slice(idx + m.length);
        idx = out.toLowerCase().indexOf(m.toLowerCase(), idx + m.length + 2);
        guard++;
      }
    });
    return out;
  }

  /**
   * 术语一致性校验（纯本地 · 不联网 · 不调用 AI）
   * ⚠️ 2026-10 修：原先只返回一串「有几处」的文字说明，用户根本不知道去哪儿改。
   * 现在每条都带**段落号 + 原文片段（命中词【】框出）+ 建议**，另附标注版全文。
   */
  function checkTerms(cn, en) {
    var issues = [], marks = [], hit = 0;
    var src = String(cn || "");
    var raw = String(en || "");
    var enl = raw.toLowerCase();
    var paras = raw.split("\n");

    TERM_PAIRS.forEach(function (p) {
      if (src.indexOf(p.cn) < 0) return;
      hit++;
      var hasMain = enl.indexOf(p.en.toLowerCase()) >= 0;
      var alts = p.alts.filter(function (a) { return enl.indexOf(a.toLowerCase()) >= 0; });
      var kind, suggest, lookFor = "";
      if (!hasMain && !alts.length) {
        kind = "译文里未找到对应译法";
        suggest = "建议在英文栏使用「" + p.en + "」";
      } else if (hasMain && alts.length) {
        kind = "译法不统一：「" + p.en + "」与「" + alts.join("、") + "」同时出现";
        suggest = "建议统一为「" + p.en + "」";
        lookFor = alts[0];
      } else if (!hasMain && alts.length) {
        kind = "用了非推荐译法「" + alts.join("、") + "」";
        suggest = "建议统一为「" + p.en + "」";
        lookFor = alts[0];
      } else {
        return;
      }
      // 定位到具体段落 + 截原文片段 —— 这是本次修复的核心
      var seek = (lookFor || p.en).toLowerCase();
      var paraEn = 0, excerpt = "";
      for (var i = 0; i < paras.length; i++) {
        if (paras[i].toLowerCase().indexOf(seek) >= 0) {
          paraEn = i + 1;
          excerpt = termExcerpt(paras[i], seek);
          break;
        }
      }
      marks.push(lookFor || p.en);
      issues.push({ cn: p.cn, kind: kind, paraEn: paraEn, excerpt: excerpt, suggest: suggest });
    });
    return { hit: hit, issues: issues, marked: buildMarked(raw, marks) };
  }

  function loadSaved() { try { var l = localStorage.getItem(LS.saved); var a = l ? JSON.parse(l) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveSaved(a) { try { localStorage.setItem(LS.saved, JSON.stringify(a)); } catch (e) { } }
  function aiTranslate(text, dir) {
    try { return (window.__callAI && window.__callAI("legal-translation", { text: text, dir: dir })) || "<p>（AI 桥未接）</p>"; }
    catch (e) { return "<p>AI 生成失败。</p>"; }
  }
  function aiPolish(text) {
    try { return (window.__callAI && window.__callAI("legal-polish", { text: text })) || "<p>（AI 桥未接）</p>"; }
    catch (e) { return "<p>AI 生成失败。</p>"; }
  }

  function render(container, title, sub) {
    var saved = loadSaved();
    var html =
      "<style>.intl-note{font-size:12px;opacity:.62}.intl-sec{display:none}.intl-sec.on{display:block}.intl-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.intl-ta{width:100%;min-height:180px;resize:vertical;border-radius:10px;border:1px solid rgba(127,127,127,.25);background:rgba(127,127,127,.05);color:inherit;font-family:inherit;font-size:13px;padding:10px}.intl-saved{display:block;padding:10px 0;border-bottom:1px solid rgba(127,127,127,.12);font-size:13px}</style>"
      + '<div class="page-head"><div><h1>' + esc(title) + "</h1><div class='sub'>" + esc(sub) + "</div></div></div>"
      + '<div class="tabs" style="margin-bottom:14px">'
      + [["library", "双语模板库"], ["gen", "生成 / 编辑"], ["trans", "法律翻译"], ["cert", "认证指引"], ["saved", "已生成(" + saved.length + ")"]].
        map(function (t) { return '<button class="' + (state.tab === t[0] ? "active" : "") + '" data-tab="' + t[0] + '">' + t[1] + "</button>"; }).join("")
      + "</div>";

    // 模板库
    // 2026-10 修：头部原先是个纯 <span> badge（「中英对照 · 点击生成」），看着能点、点了没反应。
    // 改成真按钮：已选模板就跳到「生成 / 编辑」，没选就明确提示。
    html += '<div class="intl-sec' + (state.tab === "library" ? " on" : "") + '" data-sec="library"><div class="card glow"><div class="card-head"><h2>涉外双语文书模板库</h2>'
      + '<button class="btn btn-sm btn-ghost" id="libGoGen">' + (state.current ? "去生成 / 编辑 ›" : "中英对照 · 选模板后点「生成」") + "</button></div>"
      // 2026-10-11：对齐鸿蒙端 —— 模板卡片加「查看原文」（单开手风琴 + 中英切换）。
      // 面板一开始就渲染好、默认 display:none，点按钮只切显隐，不重新 render。
      + TEMPLATES.map(function (t) { return '<div class="intl-saved">' +
        '<div class="card-title-row">' +
        '<span class="link ctr-title" data-open="' + t.id + '">' + esc(t.name) + "</span></div>" +
        '<div class="card-meta">' + esc(t.en) + "</div>" +
        '<div class="tl-meta" style="font-size:12px;opacity:.7;margin-top:4px">' + esc(t.intro) + "</div>" +
        '<div class="tpl-orig" data-origpanel="' + t.id + '" style="display:none">' +
        '<div class="filter-chips" style="margin-bottom:8px">' +
        '<button class="btn btn-sm ' + (origLang === "cn" ? "btn-primary" : "btn-ghost") + '" data-origlang="cn">中文</button>' +
        '<button class="btn btn-sm ' + (origLang === "en" ? "btn-primary" : "btn-ghost") + '" data-origlang="en">English</button>' +
        "</div>" +
        '<div class="tpl-orig-body" data-origbody="cn"' + (origLang === "cn" ? "" : ' style="display:none"') + ">" + esc(t.bodyCn.join("\n\n")) + "</div>" +
        '<div class="tpl-orig-body" data-origbody="en"' + (origLang === "en" ? "" : ' style="display:none"') + ">" + esc(t.bodyEn.join("\n\n")) + "</div>" +
        "</div>" +
        '<div class="card-actions">' +
        '<button class="btn btn-sm btn-primary" data-use="' + t.id + '"> 生成</button>' +
        '<button class="btn btn-sm btn-ghost" data-orig="' + t.id + '">查看原文</button>' +
        "</div></div>"; }).join("")
      + (userTpls.length ? '<div style="margin-top:14px;font-size:12px;opacity:.7">自有模板（本机）</div>'
        + userTpls.map(function (u) {
          return '<div class="intl-saved">' +
            '<span style="font-weight:600">' + esc(u.name) + '</span>' +
            '<span style="font-size:11px;opacity:.6;margin-left:8px">自有</span>' +
            '<div class="card-actions">' +
            '<button class="btn btn-sm btn-primary" data-uuse="' + u.id + '"> 生成</button>' +
            '<button class="btn btn-sm btn-ghost" data-udel="' + u.id + '">删除</button></div></div>';
        }).join("") : "")
      + '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
      + '<label class="btn btn-sm btn-ghost" style="cursor:pointer;margin:0">＋ 上传自有模板<input type="file" id="intlTplFile" accept=".txt,.md,.html" style="display:none"></label>'
      + '<span style="font-size:11px;opacity:.62">上传本所模板（.txt / .md），正文里用 {{变量名}} 作占位符；原文只存本机、不上传</span>'
      + "</div></div></div>";

    // 生成/编辑
    html += '<div class="intl-sec' + (state.tab === "gen" ? " on" : "") + '" data-sec="gen"><div class="card glow" id="genWrap"><div class="card-head"><h2> 生成 / 编辑</h2><span class="badge badge-info">中英双栏 · 可编辑</span></div>'
      + '<div class="intl-note" style="margin-bottom:10px">' + (TEMPLATES.find(function (t) { return t.id === state.current; }) ? "当前模板：" + esc(TEMPLATES.find(function (t) { return t.id === state.current; }).name) : "请先在『双语模板库』选择一个模板生成") + "</div>"
      + '<div class="intl-two" id="genEdit"><div><div style="font-weight:600;margin-bottom:6px">中文</div><textarea id="gCn" class="intl-ta"></textarea></div>'
      + '<div><div style="font-weight:600;margin-bottom:6px">English</div><textarea id="gEn" class="intl-ta"></textarea></div></div>'
      + '<div id="gVars"></div>'
      // 位置提示：桌面端是并排两栏，手机端（鸿蒙）是上下两栏 —— 两种都说清楚，
      // 否则用户生成完只看得到中文，以为英文没出来。
      + '<div class="intl-note" style="margin-top:10px">位置提示：中文栏在左、英文栏在右（手机端为上下两栏，英文在中文下方）；点「生成」后两栏自动填充，可分别编辑。</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
      // 前四个是「产出型」按钮 —— 点了变实心（单选），再点同一个取消
      // 前四个是「产出型」按钮 —— 点了变实心（单选），再点同一个取消
      + '<button class="btn btn-sm ' + (activeAction === "trans" ? "btn-primary" : "btn-ghost") + '" id="gTrans" data-act="trans"> 中英 翻译</button>'
      + '<button class="btn btn-sm ' + (activeAction === "polish" ? "btn-primary" : "btn-ghost") + '" id="gPolish" data-act="polish"> AI 润色校对</button>'
      + '<button class="btn btn-sm ' + (activeAction === "term" ? "btn-primary" : "btn-ghost") + '" id="gTerm" data-act="term"> 术语校验</button>'
      + '<button class="btn btn-sm ' + (activeAction === "harness" ? "btn-primary" : "btn-ghost") + '" id="gHarness" data-act="harness"> Harness 生成</button>'
      // 后四个是一次性动作（导出/打印/复制/保存），不做选中态
      + '<button class="btn btn-sm btn-ghost" id="gExportDocx"> 导出 Word</button>'
      + '<button class="btn btn-sm btn-ghost" id="gPrint"> 打印/PDF</button>'
      + '<button class="btn btn-sm btn-ghost" id="gCopy"> 复制</button>'
      + '<button class="btn btn-sm btn-primary" id="gSave"> 保存</button>'
      + "</div><div id='genOut' style='margin-top:10px'></div><div id='termOut' style='margin-top:10px'></div></div></div>";

    // 法律翻译
    html += '<div class="intl-sec' + (state.tab === "trans" ? " on" : "") + '" data-sec="trans"><div class="card glow"><div class="card-head"><h2> 法律翻译</h2><span class="badge badge-info">中英术语一致 · 可编辑</span></div>'
      + '<div class="intl-two"><div><div style="font-weight:600;margin-bottom:6px">文本</div><textarea id="tSrc" class="intl-ta" placeholder="粘贴中文或英文法律文本…"></textarea></div>'
      + '<div><div style="font-weight:600;margin-bottom:6px">译文</div><textarea id="tDst" class="intl-ta" placeholder="译文将显示在这里"></textarea></div></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
      + '<button class="btn btn-sm btn-primary" id="tToEn">中  英</button>'
      + '<button class="btn btn-sm btn-ghost" id="tToCn">英  中</button>'
      + "</div>"
      + '<div class="card-head" style="margin-top:14px"><h2> 中英法律术语对照（常用）</h2></div>'
      + '<div class="doc-meta"><div class="mi"><b>诉讼</b><span>起诉状 complaint · 答辩状 statement of defense · 证据 evidence · 一审 first instance</span></div>'
      + '<div class="mi"><b>仲裁</b><span>仲裁申请书 application for arbitration · 仲裁庭 tribunal · 裁决 award · 承认与执行 recognition & enforcement</span></div>'
      + '<div class="mi"><b>交易</b><span>保密协议 NDA · 违约 breach · 准据法 governing law · 争议解决 dispute resolution</span></div></div>'
      + "<div id='tOut' style='margin-top:10px'></div></div></div>";

    // 认证指引
    html += '<div class="intl-sec' + (state.tab === "cert" ? " on" : "") + '" data-sec="cert"><div class="card glow"><div class="card-head"><h2> 公证 / 认证 / 海牙认证指引</h2><span class="badge badge-info">参考 · 以当地要求为准</span></div>'
      + CERT_GUIDE.map(function (c) { return '<div style="padding:10px 0;border-bottom:1px solid rgba(127,127,127,.1)"><b>' + esc(c.t) + "</b>：" + esc(c.d) + "</div>"; }).join("") +
      "<div class='intl-note' style='margin-top:10px'>海牙公约适用与否、认证要求视目的国而定，务必提前核实，避免文件因认证瑕疵被拒。</div></div></div>";

    // 已生成
    html += '<div class="intl-sec' + (state.tab === "saved" ? " on" : "") + '" data-sec="saved"><div class="card glow"><div class="card-head"><h2>已生成双语文书（' + saved.length + "）</h2><span class=\"badge badge-info\">本地留档</span></div>"
      + (saved.length ? saved.map(function (s) { return '<div class="intl-saved">' +
        '<span style="font-weight:600">' + esc(s.name) + "</span>" +
        '<span style="font-size:11px;opacity:.6;margin-left:8px">' + esc(s.date) + "</span>" +
        '<div style="margin-top:6px"><button class="btn btn-sm btn-ghost" data-view="' + s.id + '">预览</button> <button class="btn btn-sm btn-ghost" data-dels="' + s.id + '">删除</button></div>'
        + '<div class="intl-box" data-b="' + s.id + '" style="display:none"></div></div>'; }).join("") : '<div class="empty">尚未保存双语文书。</div>') +
      "</div></div>";

    container.innerHTML = html;
    bind(container);
    if (state.tab === "gen" && state.current) prefillGen(container);
  }

  function bind(container) {
    container.querySelectorAll("[data-tab]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.tab = b.getAttribute("data-tab");
        container.querySelectorAll("[data-sec]").forEach(function (s) { s.classList.toggle("on", s.getAttribute("data-sec") === state.tab); });
        container.querySelectorAll("[data-tab]").forEach(function (x) { x.classList.toggle("active", x === b); });
        if (state.tab === "gen" && state.current) prefillGen(container);
      });
    });
    var goGen = byId("libGoGen");
    if (goGen) goGen.addEventListener("click", function () {
      if (state.current) { switchTabAndRender(container, "gen"); if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已切到「生成 / 编辑」", "success"); }
      else if (window.Workbench && window.Workbench.toast) window.Workbench.toast("请先在下方任一模板上点「生成」", "error");
    });
    var upFile = byId("intlTplFile");
    if (upFile) upFile.addEventListener("change", function () {
      var f = this.files && this.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function (e) {
        var txt = String(e.target.result || "");
        if (!txt.trim()) { if (window.Workbench && window.Workbench.toast) window.Workbench.toast("文件内容为空", "error"); return; }
        userTpls.unshift({ id: "u" + Date.now(), name: f.name, text: txt });
        saveUserTpls(); render(container);
        if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已上传自有模板：" + f.name, "success");
      };
      rd.readAsText(f);
    });
    container.querySelectorAll("[data-uuse]").forEach(function (b) {
      b.addEventListener("click", function () { useUserTpl(container, b.getAttribute("data-uuse")); });
    });
    container.querySelectorAll("[data-udel]").forEach(function (b) {
      b.addEventListener("click", function () { removeUserTpl(container, b.getAttribute("data-udel")); });
    });
    var gH = byId("gHarness");
    if (gH) gH.addEventListener("click", function () { markActive(container, "harness"); harnessGen(container); });

    // 「查看原文」：单开手风琴（对齐鸿蒙端，同一时刻只展开一个模板）。
    // ⚠️ 只切 DOM 显隐 + 改按钮文案，不重新 render —— render 会重建 innerHTML，
    // 把用户在「生成 / 编辑」里已经改过的正文冲掉。
    container.querySelectorAll("[data-orig]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-orig");
        openTplId = (openTplId === id) ? "" : id;
        container.querySelectorAll("[data-origpanel]").forEach(function (p) {
          p.style.display = (p.getAttribute("data-origpanel") === openTplId) ? "block" : "none";
        });
        container.querySelectorAll("[data-orig]").forEach(function (x) {
          x.textContent = (x.getAttribute("data-orig") === openTplId) ? "收起原文" : "查看原文";
        });
      });
    });
    // 中英切换（面板内）：中文正文上千字会把英文顶到十几屏外，切换后各占一屏
    container.querySelectorAll("[data-origlang]").forEach(function (b) {
      b.addEventListener("click", function () {
        origLang = b.getAttribute("data-origlang");
        applyOrigLang(container);
      });
    });
    container.querySelectorAll("[data-use]").forEach(function (b) {
      b.addEventListener("click", function () { activeAction = ""; state.current = b.getAttribute("data-use"); state.userText = ""; state.tab = "gen"; switchTabAndRender(container, "gen"); });
    });
    container.querySelectorAll("[data-open]").forEach(function (b) {
      b.addEventListener("click", function () {
        var t = TEMPLATES.find(function (x) { return x.id === b.getAttribute("data-open"); });
        var box = container.querySelector('[data-b="' + t.id + '"]'); // reuse
      });
    });
    var gTrans = byId("gTrans"); if (gTrans) gTrans.addEventListener("click", function () { markActive(container, "trans"); var cn = byId("gCn").value; var en = byId("gEn"); if (en) en.value = aiTranslate(cn, "cn-en").replace(/<[^>]+>/g, ""); setGenOut(byId("genOut"), "中英翻译（骨架·待 LLM 接入后为准）"); });
    var gPolish = byId("gPolish"); if (gPolish) gPolish.addEventListener("click", function () { markActive(container, "polish"); var cn = byId("gCn").value; setGenOut(byId("genOut"), aiPolish(cn)); });
    // 术语一致性校验（纯本地 · 不联网 · 不调用 AI）
    var gTerm = byId("gTerm"); if (gTerm) gTerm.addEventListener("click", function () { markActive(container, "term");
      var out = byId("termOut");
      if (!out) return;
      var cn = byId("gCn") ? byId("gCn").value : "";
      var en = byId("gEn") ? byId("gEn").value : "";
      if (!String(cn).trim() || !String(en).trim()) {
        out.innerHTML = '<div class="intl-note">请先在中英两栏都填入内容，再做术语校验。</div>';
        return;
      }
      var r = checkTerms(cn, en);
      var head = r.issues.length === 0
        ? '<b>术语一致性：通过</b>（命中核心术语 ' + r.hit + ' 个）'
        : '<b style="color:#e05555">术语一致性：' + r.issues.length + ' 处待处理</b>（命中核心术语 ' + r.hit + ' 个）';
        // 2026-10 修：每条给出「第几段 + 原文片段（命中词【】框出）+ 建议」，另附标注版全文
        var detail = r.issues.map(function (it, i) {
          return '<div style="margin-top:8px">'
            + '<div style="font-weight:600;color:#e05555">' + (i + 1) + '. '
            + (it.paraEn > 0 ? '英文第 ' + it.paraEn + ' 段 · ' : '')
            + '「' + esc(it.cn) + '」· ' + esc(it.kind) + '</div>'
            + (it.excerpt ? '<div style="margin-top:2px">原文：' + esc(it.excerpt) + '</div>' : '')
            + '<div style="margin-top:2px;opacity:.75">→ ' + esc(it.suggest) + '</div>'
            + '</div>';
        }).join("");
        var marked = r.issues.length
          ? '<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(127,127,127,.18)">'
            + '<div style="font-weight:600">英文栏标注版（命中处用【】框出，可直接对照修改）</div>'
            + '<div style="margin-top:6px;white-space:pre-wrap;max-height:320px;overflow:auto">'
            + esc(r.marked) + '</div></div>'
          : "";
      out.innerHTML = '<div style="padding:10px 13px;border-radius:10px;background:rgba(127,127,127,.06);border:1px solid rgba(127,127,127,.18);font-size:12.5px;line-height:1.7">'
        + head
        + detail
        + marked
        + '<div class="intl-note">校验范围：本机术语表的关键词级比对，不联网、不调用 AI；用于发现漏译与译法不统一，不替代专业审校。</div></div>';
    });
    var gExport = byId("gExportDocx");
    if (gExport) gExport.addEventListener("click", function () { exportWordDocx(); });
    var gPrint = byId("gPrint"); if (gPrint) gPrint.addEventListener("click", function () { printGen(); });
    var gCopy = byId("gCopy"); if (gCopy) gCopy.addEventListener("click", function () { var v = (byId("gCn") ? byId("gCn").value : "") + "\n\n==========\n\n" + (byId("gEn") ? byId("gEn").value : ""); try { navigator.clipboard.writeText(v); setGenOut(byId("genOut"), "已复制到剪贴板"); } catch (e) { setGenOut(byId("genOut"), "复制失败（请手动复制）"); } });
    var gSave = byId("gSave"); if (gSave) gSave.addEventListener("click", function () { saveGen(container); });
    var tToEn = byId("tToEn"); if (tToEn) tToEn.addEventListener("click", function () { var d = byId("tDst"); if (d) d.value = aiTranslate((byId("tSrc") || { value: "" }).value, "cn-en").replace(/<[^>]+>/g, ""); setGenOut(byId("tOut"), "已生成译文（骨架·待 LLM 接入后为准）"); });
    var tToCn = byId("tToCn"); if (tToCn) tToCn.addEventListener("click", function () { var d = byId("tDst"); if (d) d.value = aiTranslate((byId("tSrc") || { value: "" }).value, "en-cn").replace(/<[^>]+>/g, ""); setGenOut(byId("tOut"), "已生成译文（骨架·待 LLM 接入后为准）"); });
    container.querySelectorAll("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () { var id = b.getAttribute("data-view"); var s = loadSaved().find(function (x) { return x.id === id; }); var box = container.querySelector('[data-b="' + id + '"]'); if (box) { box.style.display = "block"; box.innerHTML = viewHtml(s); } });
    });
    container.querySelectorAll("[data-dels]").forEach(function (b) {
      b.addEventListener("click", function () { var id = b.getAttribute("data-dels"); if (!confirm("删除该文书？")) return; saveSaved(loadSaved().filter(function (x) { return x.id !== id; })); render(container); if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已删除", "success"); });
    });
  }

  function switchTabAndRender(container, tab) { state.tab = tab; render(container); }

  // —— 变量填充 ——
  // 从当前模板里**扫描出实际出现的占位符**（{{甲方}} 等）动态生成输入框，不写死字段：
  // 以后模板增删变量，UI 自动跟随，不会出现「正文里有变量、界面上却没地方填」。
  var VAR_LABEL = { "{{甲方}}": "甲方", "{{乙方}}": "乙方", "{{日期}}": "日期", "{{期限}}": "期限",
    "{{准据法}}": "准据法", "{{争议解决机构}}": "争议解决机构", "{{交易事项}}": "交易事项",
    "{{案由}}": "案由", "{{不招揽期限}}": "不招揽期限", "{{返还期限}}": "返还期限",
    "{{优先文本}}": "优先文本", "{{委托事项}}": "委托事项" };
  var VAR_DEMO = { "{{准据法}}": "中华人民共和国法律",
    "{{争议解决机构}}": "中国国际经济贸易仲裁委员会（CIETAC）",
    "{{优先文本}}": "中文", "{{期限}}": "三年", "{{返还期限}}": "十五个工作日",
    "{{不招揽期限}}": "两年" };
  // 中文占位符 → 英文栏里对应的英文占位符（英文正文不该夹中文）
  var VAR_KEY_EN = { "{{甲方}}": "{{Party A}}", "{{乙方}}": "{{Party B}}", "{{日期}}": "{{Date}}",
    "{{期限}}": "{{Term}}", "{{准据法}}": "{{Governing Law}}",
    "{{争议解决机构}}": "{{Arbitration Institution}}", "{{交易事项}}": "{{Transaction}}",
    "{{案由}}": "{{Cause of Action}}", "{{不招揽期限}}": "{{Non-solicitation Period}}",
    "{{返还期限}}": "{{Return Period}}", "{{优先文本}}": "{{Prevailing Language}}",
    "{{委托事项}}": "{{Matters Authorised}}" };
  function varKeyEn(k) { return VAR_KEY_EN[k] || k; }
  function collectVars(t) {
    var seen = {}, out = [];
    t.bodyCn.forEach(function (line) {
      (line.match(/\{\{[^}]+\}\}/g) || []).forEach(function (k) {
        if (!seen[k]) { seen[k] = 1; out.push(k); }
      });
    });
    return out;
  }
  function renderVars(t) {
    var box = byId("gVars"); if (!box) return;
    var vars = collectVars(t);
    if (!vars.length) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="intl-note" style="margin-top:12px">变量填充（共 ' + vars.length
      + ' 项）：填好后点「一键填充」，正文里对应的 <code>{{占位符}}</code> 一次替换；留空的不动。</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">'
      + vars.map(function (k) {
        var label = VAR_LABEL[k] || k.replace(/[{}]/g, "");
        return '<label style="display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--text-dim,#6b7280)">'
          + esc(label)
          + '<input data-var="' + esc(k) + '" placeholder="' + esc(VAR_DEMO[k] || "") + '"'
          + ' style="min-width:150px;height:32px;padding:0 10px;font-size:12.5px;border-radius:8px;'
          + 'border:1px solid var(--border,#d8dce6);background:var(--surface,#fff);color:var(--text,#111)">'
          + '</label>';
      }).join("")
      + '<button class="btn btn-sm" id="gFillVars" style="height:32px">一键填充</button>'
      + '</div>';
    var btn = byId("gFillVars");
    if (btn) btn.addEventListener("click", function () {
      var pairs = [];
      box.querySelectorAll("[data-var]").forEach(function (inp) {
        var v = (inp.value || "").trim();
        if (v) pairs.push([inp.getAttribute("data-var"), v]);
      });
      if (!pairs.length) { setGenOut(byId("genOut"), "请先至少填写一个变量值"); return; }
      var n = 0;
      [byId("gCn"), byId("gEn")].forEach(function (el) {
        if (!el) return;
        var s = el.value;
        var isEn = (el === enEl);
        pairs.forEach(function (p) {
          var key = isEn ? varKeyEn(p[0]) : p[0];
          n += s.split(key).length - 1;
          s = s.split(key).join(p[1]);
        });
        el.value = s;
      });
      setGenOut(byId("genOut"), "已替换 " + pairs.length + " 个变量（共 " + n + " 处占位符）");
    });
  }
  function prefillGen(container) {
    var cn = byId("gCn"), en = byId("gEn");
    // 自有模板：整篇原文进中文栏，英文栏留空待翻译
    if (state.userText) {
      var u = userTpls.find(function (x) { return x.id === state.current; });
      if (cn) { cn.value = state.userText; }
      if (en) { en.value = ""; }
      renderVars({ bodyCn: [state.userText], bodyEn: [] });
      return;
    }
    var t = TEMPLATES.find(function (x) { return x.id === state.current; }); if (!t) return;
    if (cn) { cn.value = t.bodyCn.join("\n\n"); }
    if (en) { en.value = t.bodyEn.join("\n\n"); }
    renderVars(t);
  }
  function setGenOut(el, msg) { if (!el) return; el.innerHTML = '<div class="ai-box">' + esc(msg) + "</div>"; }

  // —— 自有模板：上传 / 使用 / 删除 ——
  function useUserTpl(container, id) {
    var u = userTpls.find(function (x) { return x.id === id; }); if (!u) return;
    state.current = id; state.userText = u.text; state.tab = "gen";
    switchTabAndRender(container, "gen");
  }
  function removeUserTpl(container, id) {
    if (!confirm("删除该自有模板？")) return;
    userTpls = userTpls.filter(function (x) { return x.id !== id; });
    saveUserTpls(); render(container);
    if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已删除自有模板", "success");
  }

  /** Harness 生成：优先调用桌面端内置 agent，否则本地按「保持结构、补全空白」回退并如实标注 */
  function harnessGen(container) {
    var cn = (byId("gCn") || { value: "" }).value, en = (byId("gEn") || { value: "" }).value;
    if (!cn.trim() && !en.trim()) { setGenOut(byId("genOut"), "请先选择模板或输入正文"); return; }
    var src = cn.trim() ? cn : en;
    if (window.__callHarness && typeof window.__callHarness === "function") {
      try {
        byId("gCn").value = window.__callHarness("harness-doc", { text: src }, "");
        setGenOut(byId("genOut"), "Harness 生成完成（桌面端内置 AI，已回填中文栏）");
        return;
      } catch (e) { /* 落到本地回退 */ }
    }
    // 本地回退：不谎称成功，明确标注是骨架补全而非 AI 产出
    var filled = src.replace(/_{4,}/g, "【待补充】");
    byId("gCn").value = filled;
    setGenOut(byId("genOut"), "Harness 生成：当前未接算力，已做本地结构补全（把空白处标为【待补充】），非 AI 产出。");
  }
  function saveGen(container) {
    var t = TEMPLATES.find(function (x) { return x.id === state.current; });
    var cnv = (byId("gCn") || { value: "" }).value, env = (byId("gEn") || { value: "" }).value;
    if (!cnv && !env) { alert("内容为空"); return; }
    var s = { id: "d" + Date.now(), name: t ? t.name : "未命名双语文书", date: dateStr(), cn: cnv, en: env };
    var a = loadSaved(); a.unshift(s); saveSaved(a); render(container);
    if (window.Workbench && window.Workbench.toast) window.Workbench.toast("已保存", "success");
  }
  function viewHtml(s) {
    if (!s) return "<div class='empty'>未找到</div>";
    return '<div class="ai-box"><b>' + esc(s.name) + "</b>（" + esc(s.date) + "）<br><br>" +
      "<b>中文</b><br><pre style='white-space:pre-wrap;font-family:inherit;font-size:13px;margin:6px 0'>" + esc(s.cn) + "</pre>" +
      "<b>English</b><br><pre style='white-space:pre-wrap;font-family:inherit;font-size:13px;margin:6px 0'>" + esc(s.en) + "</pre></div>";
  }
  /**
   * 导出**真 .docx**（OOXML）—— 用 window.Docx.build 生成，不是「HTML 改后缀」的假 docx。
   * 设计意图：内置打印是固定版式；想要自己版式的用户走导出，在电脑或手机 WPS 里排。
   */
  function exportWordDocx() {
    var cn = (byId("gCn") || { value: "" }).value;
    var en = (byId("gEn") || { value: "" }).value;
    if (!String(cn).trim() && !String(en).trim()) {
      setGenOut(byId("genOut"), "内容为空，无法导出");
      return;
    }
    if (!window.Docx || typeof window.Docx.build !== "function") {
      setGenOut(byId("genOut"), "导出失败：docx 生成器未加载（检查 index.html 是否引入 js/docx.js）");
      return;
    }
    var t = TEMPLATES.find(function (x) { return x.id === state.current; });
    var u = !t ? userTpls.find(function (x) { return x.id === state.current; }) : null;
    var title = t ? t.name : (u ? u.name : "双语文书");
    var paras = [];
    var pushAll = function (src) {
      String(src).split("\n").forEach(function (line) { if (line.trim()) paras.push(line.trim()); });
    };
    if (String(cn).trim()) pushAll(cn);
    if (String(en).trim()) { if (paras.length) paras.push(""); pushAll(en); }
    try {
      var bytes = window.Docx.build(title, paras);
      var blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = title + ".docx";
      a.click();
      setGenOut(byId("genOut"), "已导出 .docx（OOXML，Word / WPS 可直接打开编辑）。如需自己的版式：在电脑或手机 WPS 里调整后打印。内置「打印/PDF」使用的是固定版式。");
    } catch (e) {
      setGenOut(byId("genOut"), "导出失败：" + (e && e.message ? e.message : e));
    }
  }

  function printGen() {
    var w = window.open("", "_blank");
    if (!w) { alert("请允许弹出窗口以打印"); return; }
    var cn = (byId("gCn") || { value: "" }).value, en = (byId("gEn") || { value: "" }).value;
    w.document.write("<html><head><title>双语文书</title><style>body{font-family:SimSun,'Songti SC',serif;font-size:14px;line-height:1.9;padding:40px}h1{font-size:20px;text-align:center}</style></head><body><h1>双语文书</h1><h2>中文</h2><pre style='white-space:pre-wrap;font-family:inherit'>" + esc(cn) + "</pre><h2>English</h2><pre style='white-space:pre-wrap;font-family:inherit'>" + esc(en) + "</pre></body></html>");
    w.document.close(); setTimeout(function () { w.focus(); w.print(); }, 300);
  }

  // checkTerms 一并导出：便于自动化测试直接校验术语校验逻辑
  window.IntlDocs = { render: render, TEMPLATES: TEMPLATES, checkTerms: checkTerms };
})();
