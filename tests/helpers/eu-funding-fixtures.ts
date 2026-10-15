/**
 * Search hits of the EU Funding & Tenders Portal search API, captured live (October
 * 2026) and trimmed: only the metadata fields the source reads, long HTML texts cut
 * to about 700 characters, at most two documents and info items each, and e-mail
 * addresses replaced. Metadata values are arrays, as upstream.
 */

/** A current Horizon Europe topic: two-stage, two deadlines, a call with two budget lines. */
export const TOPIC_HIT = {
  "reference": "50131259TOPICSen",
  "url": "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-CL4-2027-02-MAT-PROD-32-two-stage",
  "summary": "Efficient energy input from renewable sources and energy management in the process industries (IA) (Processes4Planet and Innovative Advanced Materials for the EU partnerships)",
  "language": "en",
  "metadata": {
    "type": [
      "1"
    ],
    "status": [
      "31094502"
    ],
    "identifier": [
      "HORIZON-CL4-2027-02-MAT-PROD-32-two-stage"
    ],
    "callIdentifier": [
      "HORIZON-CL4-2027-02-two-stage"
    ],
    "callTitle": [
      "INDUSTRY-two-stage"
    ],
    "callccm2Id": [
      "50131302"
    ],
    "ccm2Id": [
      "50131259"
    ],
    "title": [
      "Efficient energy input from renewable sources and energy management in the process industries (IA) (Processes4Planet and Innovative Advanced Materials for the EU partnerships)"
    ],
    "deadlineDate": [
      "2027-02-02T00:00:00.000+0000",
      "2027-09-02T00:00:00.000+0000"
    ],
    "startDate": [
      "2026-10-13T00:00:00.000+0000"
    ],
    "deadlineModel": [
      "two-stage"
    ],
    "frameworkProgramme": [
      "43108390"
    ],
    "programmePeriod": [
      "2021 - 2027"
    ],
    "programmeDivision": [
      "43108390",
      "43108541",
      "43120193"
    ],
    "budgetOverview": [
      "{\"budgetYearsColumns\":[\"2027\"],\"budgetTopicActionMap\":{\"112901\":[{\"action\":\"HORIZON-CL4-2027-02-DIGITAL-EMERGING-52-two-stage - HORIZON-RIA HORIZON  Research and Innovation Actions\",\"expectedGrants\":5,\"minContribution\":4000000,\"maxContribution\":6000000,\"budgetYearMap\":{\"2027\":\"30000000\"},\"plannedOpeningDate\":\"2026-10-13\",\"deadlineModel\":\"two-stage\",\"deadlineDates\":[\"2027-02-02\",\"2027-09-02\"]}],\"112902\":[{\"action\":\"HORIZON-CL4-2027-02-MAT-PROD-32-two-stage - HORIZON-IA HORIZON Innovation Actions\",\"expectedGrants\":6,\"minContribution\":7000000,\"maxContribution\":9000000,\"budgetYearMap\":{\"2027\":\"52500000\"},\"plannedOpeningDate\":\"2026-10-13\",\"deadlineModel\":\"two-stage\",\"deadlineDates\":[\"2027-02-02\",\"2027-09-02\"]}]}}"
    ],
    "actions": [
      "[{\"types\":[{\"typeOfAction\":\"HORIZON-IA HORIZON Innovation Actions\",\"typeOfMGA\":[{\"id\":43027849,\"abbreviation\":\"HORIZON-AG-LS\",\"description\":\"HORIZON Lump Sum Grant\"}]}],\"status\":{\"id\":31094502,\"abbreviation\":\"Open\",\"description\":\"Open\"},\"plannedOpeningDate\":\"2026-10-13\",\"submissionProcedure\":{\"id\":31094505,\"abbreviation\":\"two-stage\",\"description\":\"two-stage\"},\"deadlineDates\":[\"2027-02-02\",\"2027-09-02\"]}]"
    ],
    "latestInfos": [
      "[{\"approvalDate\":\"\",\"lastChangeDate\":\"2026-09-03T16:22:36.845\",\"content\":\"<p>In view of the HORIZON WP update to be adopted and published on the portal on 05/10/2026, please note that the opening date for HORIZON-CL4-2027-02-two-stage will be postponed to 13/10/2026. </p>\"},{\"approvalDate\":\"\",\"lastChangeDate\":\"2026-10-14T17:35:55.871\",\"content\":\"The submission session is now available for: HORIZON-CL4-2027-02-DIGITAL-EMERGING-52-two-stage, HORIZON-CL4-2027-02-MAT-PROD-32-two-stage\"}]"
    ],
    "links": [
      "[{\"callIdentifier\":\"HORIZON-CL4-2027-02-two-stage\",\"criterionCode\":\"HORIZON-IA\",\"criterionDescription\":\"HORIZON Innovation Actions\",\"url\":\"https://ec.europa.eu/research/participants/submission/manage/screen/submission/create-draft/46818?topic\\u003dHORIZON-CL4-2027-02-MAT-PROD-32-two-stage\",\"startDate\":\"1791849600000\",\"endDate\":\"1801526400000\",\"mgaDescription\":\"HORIZON Lump Sum Grant\",\"mgaCode\":\"HORIZON-AG-LS\"}]"
    ],
    "typesOfAction": [
      "HORIZON Innovation Actions"
    ],
    "descriptionByte": [
      "<p class=\"topicdescriptionkind\">Expected Outcome:</p><ul level=\"0\"><li>A significant decarbonisation of processes (measured by the reduction of GHG emissions from the overall system) with broad applicability and economic viability.</li><li>Facilitation of the transition from fossil-based energy inputs for:   <ul level=\"1\"><li>low/medium thermal energy demands by introducing renewable-based alternatives and heat upgrading. </li><li>High-temperature processes, by innovative technologies for electrified and hybrid high-temperature processes, high temperature energy storage.</li>   </ul> </li><li>Clean energy usage is given a boost through innovative advanced materials, system concepts and techn…"
    ],
    "topicConditions": [
      "<div class=\"eui-u-mt-l>\"><h4>General conditions</h4><div><h4>1. Admissibility Conditions: Proposal page limit and layout</h4><div class=\"eui-u-mt-s\"><p>Applicants submitting a proposal for a blind evaluation (see General Annex F) must not disclose their organisation names, acronyms, logos nor names of personnel in the proposal abstract and Part B of their first-stage application (see General Annex E).</p></div><div class=\"eui-u-mt-s\"><p>In order to include a business case and exploitation strategy, as outlined in the introduction to Destination 'Leadership in materials and production for Europe', the page limit is exceptionally extended by 3 pages (for second-stage proposals).</p></div>…"
    ],
    "esDA_IngestDate": [
      "2026-10-14T17:38:39.766+0200"
    ],
    "esDA_FirstIngestDate": [
      "2025-12-12T15:16:05.286+0100"
    ]
  }
};

/**
 * One topic as the index holds it twice: the current (closed) record and an outdated
 * copy from 2023 that still says open (URL to the topic details JSON, no budget overview).
 */
export const CURRENT_CLOSED_HIT = {
  "reference": "45948233HORIZONCoordinationandSupportActions1683158400000",
  "url": "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-CL5-2023-D3-03-08",
  "summary": "Support to the SET Plan IWG on hydrogen",
  "language": "en",
  "metadata": {
    "type": [
      "1"
    ],
    "status": [
      "31094503"
    ],
    "identifier": [
      "HORIZON-CL5-2023-D3-03-08"
    ],
    "callIdentifier": [
      "HORIZON-CL5-2023-D3-03"
    ],
    "callTitle": [
      "Sustainable, secure and competitive energy supply"
    ],
    "callccm2Id": [
      "45705818"
    ],
    "ccm2Id": [
      "45948233"
    ],
    "title": [
      "Support to the SET Plan IWG on hydrogen"
    ],
    "deadlineDate": [
      "2023-10-10T00:00:00.000+0000"
    ],
    "startDate": [
      "2023-05-04T00:00:00.000+0000"
    ],
    "deadlineModel": [
      "single-stage"
    ],
    "frameworkProgramme": [
      "43108390"
    ],
    "programmePeriod": [
      "2021 - 2027"
    ],
    "programmeDivision": [
      "43120835",
      "43121058",
      "43121063",
      "43121068"
    ],
    "budgetOverview": [
      "{\"budgetYearsColumns\":[\"2023\"],\"budgetTopicActionMap\":{\"107649\":[{\"action\":\"HORIZON-CL5-2023-D3-03-04 - HORIZON-IA HORIZON Innovation Actions\",\"expectedGrants\":3,\"minContribution\":3000000,\"maxContribution\":4000000,\"budgetYearMap\":{\"2023\":\"11000000\"},\"plannedOpeningDate\":\"2023-05-04\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2023-10-10\"]}],\"107648\":[{\"action\":\"HORIZON-CL5-2023-D3-03-02 - HORIZON-IA HORIZON Innovation Actions\",\"expectedGrants\":2,\"minContribution\":6000000,\"maxContribution\":6000000,\"budgetYearMap\":{\"2023\":\"12000000\"},\"plannedOpeningDate\":\"2023-05-04\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2023-10-10\"]}],\"107651\":[{\"action\":\"HORIZON-CL5-2023-D3-03-08 - HORIZON-CSA HORIZON Coordination and Support Actions\",\"expectedGrants\":1,\"minContribution\":600000,\"maxContribution\":600000,\"budgetYearMap\":{\"2023\":\"600000\"},\"plannedOpeningDate\":\"2023-05-04\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2023-10-10\"]}],\"107650\":[{\"action\":\"HORIZON-CL5-2023-D3-03-05 - HORIZON-IA HORIZON Innovation Actions\",\"expectedGrants\":1,\"minContribution\":5000000,\"maxContribution\":5000000,\"budgetYearMap\":{\"2023\":\"5000000\"},\"plannedOpeningDate\":\"2023-05-04\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2023-10-10\"]}],\"107653\":[{\"action\":\"HORIZON-CL5-2023-D3-03-01 - HORIZON-RIA HORIZON  Research and Innovation Actions\",\"expectedGrants\":3,\"minContribution\":3000000,\"maxContribution\":3000000,\"budgetYearMap\":{\"2023\":\"9000000\"},\"plannedOpeningDate\":\"2023-05-04\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2023-10-10\"]}],\"107652\":[{\"action\":\"HORIZON-CL5-2023-D3-03-06 - HORIZON-IA HORIZON Innovation Actions\",\"expectedGrants\":2,\"minContribution\":5000000,\"maxContribution\":5000000,\"budgetYearMap\":{\"2023\":\"10000000\"},\"plannedOpeningDate\":\"2023-05-04\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2023-10-10\"]}],\"107654\":[{\"action\":\"HORIZON-CL5-2023-D3-03-07 - HORIZON-RIA HORIZON  Research and Innovation Actions\",\"expectedGrants\":2,\"minContribution\":3000000,\"maxContribution\":3000000,\"budgetYearMap\":{\"2023\":\"6000000\"},\"plannedOpeningDate\":\"2023-05-04\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2023-10-10\"]}],\"107647\":[{\"action\":\"HORIZON-CL5-2023-D3-03-03 - HORIZON-IA HORIZON Innovation Actions\",\"expectedGrants\":1,\"minContribution\":11000000,\"maxContribution\":11000000,\"budgetYearMap\":{\"2023\":\"11000000\"},\"plannedOpeningDate\":\"2023-05-04\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2023-10-10\"]}]}}"
    ],
    "actions": [
      "[{\"types\":[{\"typeOfAction\":\"HORIZON-CSA HORIZON Coordination and Support Actions\",\"typeOfMGA\":[{\"id\":43027846,\"abbreviation\":\"HORIZON-AG\",\"description\":\"HORIZON Action Grant Budget-Based\"}]}],\"status\":{\"id\":31094503,\"abbreviation\":\"Closed\",\"description\":\"Closed\"},\"plannedOpeningDate\":\"2023-05-04\",\"submissionProcedure\":{\"id\":31094504,\"abbreviation\":\"single-stage\",\"description\":\"single-stage\"},\"deadlineDates\":[\"2023-10-10\"]}]"
    ],
    "latestInfos": [
      "[{\"approvalDate\":\"2023-10-12\",\"lastChangeDate\":\"2023-10-12T10:54:24.703\",\"content\":\"<p>The call for proposals HORIZON-CL5-2023-D3-03 closed on 10/10/2023. 88 proposals were submitted to the call. The breakdown per topic is:</p>\\r\\n<p>HORIZON-CL5-2023-D3-03-01&#xa0;&#xa0;&#xa0; (RIA): 17 proposals</p>\\r\\n<p>HORIZON-CL5-2023-D3-03-02&#xa0;&#xa0;&#xa0; (IA): 7 proposals</p>\\r\\n<p>HORIZON-CL\"},{\"approvalDate\":\"2023-05-08\",\"lastChangeDate\":\"2023-05-08T11:38:40.773\",\"content\":\"The submission session is now available for: HORIZON-CL5-2023-D3-03-03(HORIZON-IA), HORIZON-CL5-2023-D3-03-04(HORIZON-IA), HORIZON-CL5-2023-D3-03-06(HORIZON-IA), HORIZON-CL5-2023-D3-03-07(HORIZON-RIA), HORIZON-CL5-2023-D3-03-01(HORIZON-RIA), HORIZON-CL5-2023-D3-03-08(HORIZON-CSA), HORIZON-CL5-2023-D\"}]"
    ],
    "links": [
      "[]"
    ],
    "typesOfAction": [
      "HORIZON Coordination and Support Actions"
    ],
    "descriptionByte": [
      "<p class=\"topicdescriptionkind\">Expected Outcome:</p><p>Project results are expected to contribute to the following outcomes:</p><ul level=\"0\"><li>Organisational, logistic and secretarial support provided to the SET Plan Implementation Working Group on hydrogen.</li><li>Smooth implementation through supporting the actions of the SET Plan for hydrogen in the coming years covering the whole value chain.</li> </ul><p class=\"topicdescriptionkind\">Scope:</p><p>The Implementation Working Group (IWG) on hydrogen set up in 2023 aims at implementing part of the Strategic Research and Innovation Agenda (SRIA) of the European Research Area (ERA) pilot on green hydrogen, and coordinating the work on hyd…"
    ],
    "topicConditions": [
      "<div class=\"eui-u-mt-l>\"><h4>General conditions</h4><div><h4> </h4><div class=\"eui-u-mt-s\"><h1><b>General conditions</b></h1>\r\n<p><b>1. Admissibility conditions: </b>described in <a href=\"https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/horizon/wp-call/2023-2024/wp-13-general-annexes_horizon-2023-2024_en.pdf\" target=\"_blank\">Annex A</a> and <a href=\"https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/horizon/wp-call/2023-2024/wp-13-general-annexes_horizon-2023-2024_en.pdf\" target=\"_blank\">Annex E</a> of the Horizon Europe Work Programme General Annexes</p><p><b>Proposal page limits and layout:</b> described in Part B of the Application Form available …"
    ],
    "esDA_IngestDate": [
      "2026-02-17T18:18:45.533+0100"
    ],
    "esDA_FirstIngestDate": [
      "2024-11-22T12:01:52.658+0100"
    ]
  }
};
export const OUTDATED_OPEN_HIT = {
  "reference": "45948233HORIZONCoordinationandSupportActions1683158400000",
  "url": "https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/HORIZON-CL5-2023-D3-03-08.json",
  "summary": "Support to the SET Plan IWG on hydrogen",
  "language": "en",
  "metadata": {
    "type": [
      "1"
    ],
    "status": [
      "31094502"
    ],
    "identifier": [
      "HORIZON-CL5-2023-D3-03-08"
    ],
    "callIdentifier": [
      "HORIZON-CL5-2023-D3-03"
    ],
    "callccm2Id": [
      "45705815"
    ],
    "ccm2Id": [
      "45948233"
    ],
    "title": [
      "Support to the SET Plan IWG on hydrogen"
    ],
    "deadlineDate": [
      "2023-10-10T17:00:00.000+0000"
    ],
    "startDate": [
      "2023-05-04T00:00:00.000+0000"
    ],
    "deadlineModel": [
      "single-stage"
    ],
    "frameworkProgramme": [
      "43108390"
    ],
    "programmePeriod": [
      "2021 - 2027"
    ],
    "programmeDivision": [
      "43120835",
      "43120821",
      "43121063",
      "43121058",
      "43121068",
      "43108541"
    ],
    "typesOfAction": [
      "HORIZON Coordination and Support Actions"
    ],
    "esDA_IngestDate": [
      "2023-05-08T11:46:14.262+0200"
    ]
  }
};

/** A cascade funding call (type 8), still labelled open after its deadline. */
export const CASCADE_HIT = {
  "reference": "13882COMPETITIVE_CALLen",
  "url": "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/competitive-calls-cs/46786367",
  "summary": "Enhancing the Cybersecurity Capabilities of the Domestic SME Sector (SSNS-NCC-HU-FSTP-2026)",
  "language": "en",
  "metadata": {
    "type": [
      "8"
    ],
    "status": [
      "31094502"
    ],
    "identifier": [
      "DIGITAL-ECCC-2024-DEPLOY-NCC-06-MS-COORDINATION"
    ],
    "callTitle": [
      "Enhancing the Cybersecurity Capabilities of the Domestic SME Sector (SSNS-NCC-HU-FSTP-2026)"
    ],
    "callccm2Id": [
      "13882"
    ],
    "ccm2Id": [
      "46786367"
    ],
    "title": [
      "Deploying The Network of National Coordination Centres with Member States"
    ],
    "deadlineDate": [
      "2026-06-28T22:59:00.000+0000"
    ],
    "startDate": [
      "2026-03-24T00:00:00.000+0000"
    ],
    "deadlineModel": [
      "single-stage"
    ],
    "frameworkProgramme": [
      "43152860"
    ],
    "programmePeriod": [
      "2021 - 2027"
    ],
    "budget": [
      "2000000"
    ],
    "description": [
      "<p><strong>WHO CAN SUBMIT A GRANT APPLICATION?</strong></p><p>Micro, small and medium-sized enterprises may submit grant applications for the call if they:</p><ol><li data-list=\"bullet\"><span class=\"ql-ui\" contenteditable=\"false\"></span>have at least three closed financial years (each supported by financial statements and covering full 365-day period of operation as a pre-company is not included);</li><li data-list=\"bullet\"><span class=\"ql-ui\" contenteditable=\"false\"></span>operate in the sectors listed in Annexes 2 or 3 of the Cybersecurity Act</li></ol><p><strong>WHAT ACTIVITIES ARE ELIGIBLE FOR SUPPORT?</strong></p><ol><li data-list=\"ordered\"><span class=\"ql-ui\" contenteditable=\"false\">…"
    ],
    "furtherInformation": [
      "<p>The purpose of this call for proposals is to enhance the cybersecurity resilience and risk management capabilities of the domestic SME sector, thereby contributing to the objectives of the European Cybersecurity Industrial, Technology and Research Competence Centre (hereinafter: ECCC) as set out in the Digital Europe Cybersecurity 2025-2027 Work Programme.</p><p><strong><u>Under this call for proposals:</u></strong></p><ol><li data-list=\"bullet\"><span class=\"ql-ui\" contenteditable=\"false\"></span>Micro, small and medium-sized enterprises (SMEs) may submit grant applications without territorial restrictions;</li><li data-list=\"bullet\"><span class=\"ql-ui\" contenteditable=\"false\"></span>Appli…"
    ],
    "beneficiaryAdministration": [
      "<p><strong>HOW TO SUBMIT A GRANT APPLICATION?</strong></p><ol><li data-list=\"bullet\"><span class=\"ql-ui\" contenteditable=\"false\"></span>Complete and submit your application using the online application form. Log in at https://www.palyazat.gov.hu via the \"Single sign-on Interface Login\" button to access the e-Government (EPTK) system.</li></ol><p>A user manual illustrating the use of the Unified Institutional System Interface is available at <a href=\"https://help.fair.gov.hu/node/427\" rel=\"noopener noreferrer\" target=\"_blank\">https://help.fair.gov.hu/node/427</a>.</p><p><strong>HOW ARE SUBMITTED GRANT APPLICATIONS EVALUATED? </strong></p><ol><li data-list=\"bullet\">…"
    ],
    "duration": [
      "WHEN IS THE CALL FOR PROPOSALS AVAILABLE?\nThe call for proposals with the code number SSNS-NCC-HU-FSTP-2026 entitled “Enhancing the Cybersecurity Capabilities of the Domestic SME Sector” was published on 2026.03.24 on the official website of NCC-HU and on the website https://www.palyazat.gov.hu.\n\nWHEN CAN THE GRANT APPLICATION BE SUBMITTED?\nGrant applications may be submitted electronically via the application system between 9:00 (CEST) on 8 April 2026 to 23:59 (CEST) on 28 May 2026"
    ],
    "projectAcronym": [
      "NCC-HU"
    ],
    "projectName": [
      "National Coordination Centre - Hungary"
    ],
    "projectId": [
      "101194933"
    ],
    "esDA_IngestDate": [
      "2026-05-24T20:40:05.708+0200"
    ],
    "esDA_FirstIngestDate": [
      "2026-05-08T08:59:38.614+0200"
    ],
    "caName": [
      "Enhancing the Cybersecurity Capabilities of the Domestic SME Sector (SSNS-NCC-HU-FSTP-2026)"
    ]
  }
};

/** An external action (PROSPECT) twinning call (type 2) with budget, currency and documents. */
export const PROSPECT_HIT = {
  "reference": "187686PROSPECTSEN",
  "url": "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/187686PROSPECTSEN",
  "summary": "MK 24 IPA TR 01 26 Alignment of national legislation and policies with EU Acquis for road infrastructure management together with capacity building",
  "language": "en",
  "metadata": {
    "type": [
      "2"
    ],
    "status": [
      "31094502"
    ],
    "identifier": [
      "EuropeAid/187686/ID/ACT/MK"
    ],
    "callIdentifier": [
      "187686"
    ],
    "title": [
      "MK 24 IPA TR 01 26 Alignment of national legislation and policies with EU Acquis for road infrastructure management together with capacity building"
    ],
    "deadlineDate": [
      "2026-11-05T22:59:00.000+0000"
    ],
    "startDate": [
      "2026-09-03T10:00:28.000+0000"
    ],
    "frameworkProgramme": [
      "111111"
    ],
    "programmePeriod": [
      "2014 - 2020",
      "2021 - 2027"
    ],
    "budget": [
      "1300000"
    ],
    "currency": [
      "EUR"
    ],
    "beneficiaryAdministration": [
      ":  Ministry of Transport and Public Enterprise for State Roads"
    ],
    "contractType": [
      "42958121"
    ],
    "publicationDocuments": [
      "[{\"nameDoc\":\"Twinning Fiche\",\"typeDoc\":\"pdf\",\"languageDoc\":\"EN\",\"finalPublicDocDate\":\"2026-09-03 12:00:22.0\",\"docUrl\":\"https://webgate.ec.europa.eu/prospect/internal/noauth/externalDocumentDownload.htm?id=2214470&lang=EN\"},{\"nameDoc\":\"Annex C9 Standard Twinning\",\"typeDoc\":\"pdf\",\"languageDoc\":\"EN\",\"finalPublicDocDate\":\"2026-09-03 12:00:33.0\",\"docUrl\":\"https://webgate.ec.europa.eu/prospect/internal/noauth/externalDocumentDownload.htm?id=2214469&lang=EN\"}]"
    ],
    "esDA_IngestDate": [
      "2026-09-03T12:01:00.601+0200"
    ],
    "esDA_FirstIngestDate": [
      "2026-09-03T12:01:00.601+0200"
    ],
    "caName": [
      "true"
    ]
  }
};

/** MSCA Doctoral Networks: one budget line listed once per type of action (three rows, one amount). */
export const MSCA_DN_HIT = {
  "reference": "50220812TOPICSen",
  "url": "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-MSCA-2026-DN-01-01",
  "summary": "MSCA Doctoral Networks 2026",
  "language": "en",
  "metadata": {
    "type": [
      "1"
    ],
    "status": [
      "31094502"
    ],
    "identifier": [
      "HORIZON-MSCA-2026-DN-01-01"
    ],
    "callIdentifier": [
      "HORIZON-MSCA-2026-DN-01"
    ],
    "callTitle": [
      "MSCA Doctoral Networks 2026"
    ],
    "callccm2Id": [
      "50220822"
    ],
    "ccm2Id": [
      "50220812"
    ],
    "title": [
      "MSCA Doctoral Networks 2026"
    ],
    "deadlineDate": [
      "2026-11-24T00:00:00.000+0000"
    ],
    "startDate": [
      "2026-05-28T00:00:00.000+0000"
    ],
    "deadlineModel": [
      "single-stage"
    ],
    "frameworkProgramme": [
      "43108390"
    ],
    "programmePeriod": [
      "2021 - 2027"
    ],
    "programmeDivision": [
      "43108486",
      "43108473",
      "43108394",
      "43108390"
    ],
    "budgetOverview": [
      "{\"budgetYearsColumns\":[\"2026\"],\"budgetTopicActionMap\":{\"113402\":[{\"action\":\"HORIZON-MSCA-2026-DN-01-01 - HORIZON-TMA-MSCA-DN HORIZON TMA MSCA Doctoral Networks\",\"expectedGrants\":0,\"minContribution\":0,\"maxContribution\":0,\"budgetYearMap\":{\"2026\":\"628033846\"},\"plannedOpeningDate\":\"2026-05-28\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2026-11-24\"]},{\"action\":\"HORIZON-MSCA-2026-DN-01-01 - HORIZON-TMA-MSCA-DN-JD HORIZON TMA MSCA Doctoral Networks - Joint Doctorates\",\"expectedGrants\":0,\"minContribution\":0,\"maxContribution\":0,\"budgetYearMap\":{\"2026\":\"628033846\"},\"plannedOpeningDate\":\"2026-05-28\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2026-11-24\"]},{\"action\":\"HORIZON-MSCA-2026-DN-01-01 - HORIZON-TMA-MSCA-DN-ID HORIZON TMA MSCA Doctoral Networks - Industrial Doctorates\",\"expectedGrants\":0,\"minContribution\":0,\"maxContribution\":0,\"budgetYearMap\":{\"2026\":\"628033846\"},\"plannedOpeningDate\":\"2026-05-28\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2026-11-24\"]}]}}"
    ],
    "actions": [
      "[{\"types\":[{\"typeOfAction\":\"HORIZON-TMA-MSCA-DN HORIZON TMA MSCA Doctoral Networks\",\"typeOfMGA\":[{\"id\":43251971,\"abbreviation\":\"HORIZON-AG-UN\",\"description\":\"HORIZON Unit Grant\"}]}],\"status\":{\"id\":31094502,\"abbreviation\":\"Open\",\"description\":\"Open\"},\"plannedOpeningDate\":\"2026-05-28\",\"submissionProcedure\":{\"id\":31094504,\"abbreviation\":\"single-stage\",\"description\":\"single-stage\"},\"deadlineDates\":[\"2026-11-24\"]},{\"types\":[{\"typeOfAction\":\"HORIZON-TMA-MSCA-DN HORIZON TMA MSCA Doctoral Networks\",\"typeOfMGA\":[{\"id\":43251971,\"abbreviation\":\"HORIZON-AG-UN\",\"description\":\"HORIZON Unit Grant\"}]},{\"typeOfAction\":\"HORIZON-TMA-MSCA-DN-JD HORIZON TMA MSCA Doctoral Networks - Joint Doctorates\",\"typeOfMGA\":[{\"id\":43251971,\"abbreviation\":\"HORIZON-AG-UN\",\"description\":\"HORIZON Unit Grant\"}]}],\"status\":{\"id\":31094502,\"abbreviation\":\"Open\",\"description\":\"Open\"},\"plannedOpeningDate\":\"2026-05-28\",\"submissionProcedure\":{\"id\":31094504,\"abbreviation\":\"single-stage\",\"description\":\"single-stage\"},\"deadlineDates\":[\"2026-11-24\",\"2026-11-24\"]},{\"types\":[{\"typeOfAction\":\"HORIZON-TMA-MSCA-DN HORIZON TMA MSCA Doctoral Networks\",\"typeOfMGA\":[{\"id\":43251971,\"abbreviation\":\"HORIZON-AG-UN\",\"description\":\"HORIZON Unit Grant\"}]},{\"typeOfAction\":\"HORIZON-TMA-MSCA-DN-JD HORIZON TMA MSCA Doctoral Networks - Joint Doctorates\",\"typeOfMGA\":[{\"id\":43251971,\"abbreviation\":\"HORIZON-AG-UN\",\"description\":\"HORIZON Unit Grant\"}]},{\"typeOfAction\":\"HORIZON-TMA-MSCA-DN-ID HORIZON TMA MSCA Doctoral Networks - Industrial Doctorates\",\"typeOfMGA\":[{\"id\":43251971,\"abbreviation\":\"HORIZON-AG-UN\",\"description\":\"HORIZON Unit Grant\"}]}],\"status\":{\"id\":31094502,\"abbreviation\":\"Open\",\"description\":\"Open\"},\"plannedOpeningDate\":\"2026-05-28\",\"submissionProcedure\":{\"id\":31094504,\"abbreviation\":\"single-stage\",\"description\":\"single-stage\"},\"deadlineDates\":[\"2026-11-24\",\"2026-11-24\",\"2026-11-24\"]}]"
    ],
    "latestInfos": [
      "[{\"approvalDate\":\"\",\"lastChangeDate\":\"2026-07-02T09:24:03.098\",\"content\":\"<p>Important update on panel selection and descriptors in Part A :</p><p><strong>Panel selection</strong></p><p>Your proposal is evaluated by the panel linked to the first \\\"project descriptor\\\" you select — not chosen directly, as in previous years.</p><p>To set this, go to <strong>General Informatio\"},{\"approvalDate\":\"\",\"lastChangeDate\":\"2026-05-28T15:48:18.925\",\"content\":\"The submission session is now available for: HORIZON-MSCA-2026-DN-01-01\"}]"
    ],
    "links": [
      "[{\"callIdentifier\":\"HORIZON-MSCA-2026-DN-01\",\"criterionCode\":\"HORIZON-TMA-MSCA-DN-ID\",\"criterionDescription\":\"HORIZON TMA MSCA Doctoral Networks - Industrial Doctorates\",\"url\":\"https://ec.europa.eu/research/participants/submission/manage/screen/submission/create-draft/44351?topic\\u003dHORIZON-MSCA-2026-DN-01-01\",\"startDate\":\"1779926400000\",\"endDate\":\"1795478400000\",\"mgaDescription\":\"HORIZON Unit Grant\",\"mgaCode\":\"HORIZON-AG-UN\"},{\"callIdentifier\":\"HORIZON-MSCA-2026-DN-01\",\"criterionCode\":\"HORIZON-TMA-MSCA-DN\",\"criterionDescription\":\"HORIZON TMA MSCA Doctoral Networks\",\"url\":\"https://ec.europa.eu/research/participants/submission/manage/screen/submission/create-draft/44350?topic\\u003dHORIZON-MSCA-2026-DN-01-01\",\"startDate\":\"1779926400000\",\"endDate\":\"1795478400000\",\"mgaDescription\":\"HORIZON Unit Grant\",\"mgaCode\":\"HORIZON-AG-UN\"},{\"callIdentifier\":\"HORIZON-MSCA-2026-DN-01\",\"criterionCode\":\"HORIZON-TMA-MSCA-DN-JD\",\"criterionDescription\":\"HORIZON TMA MSCA Doctoral Networks - Joint Doctorates\",\"url\":\"https://ec.europa.eu/research/participants/submission/manage/screen/submission/create-draft/44352?topic\\u003dHORIZON-MSCA-2026-DN-01-01\",\"startDate\":\"1779926400000\",\"endDate\":\"1795478400000\",\"mgaDescription\":\"HORIZON Unit Grant\",\"mgaCode\":\"HORIZON-AG-UN\"}]"
    ],
    "typesOfAction": [
      "HORIZON TMA MSCA Doctoral Networks",
      "HORIZON TMA MSCA Doctoral Networks - Joint Doctorates",
      "HORIZON TMA MSCA Doctoral Networks - Industrial Doctorates"
    ],
    "descriptionByte": [
      "<p class=\"topicdescriptionkind\">Expected Outcome:</p><p>Project results are expected to contribute to the following outcomes:</p><p>For supported doctoral candidates</p><ul level=\"0\"><li>New research and transferable skills and competences, leading to improved employability and career prospects within and outside academia;</li><li>New knowledge allowing the conversion of ideas into products and services, where relevant;</li><li>Enhanced networking and communication capacities with scientific peers, as well as with the general public that will increase and broaden the research and innovation impact.</li> </ul><p>For participating organisations</p><ul level=\"0\"><li>Improved quality, relevance …"
    ],
    "topicConditions": [
      "<div class=\"eui-u-mt-l>\"><h4>General conditions</h4><div><h4>1. Admissibility Conditions: Proposal page limit and layout</h4><div class=\"eui-u-mt-s\"><p>Described in <a href=\"https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/horizon/wp-call/2026-2027/wp-15-general-annexes_horizon-2026-2027_en.pdf\" rel=\"noopener noreferrer\" target=\"_blank\">Annex A</a> and <a href=\"https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/horizon/wp-call/2026-2027/wp-15-general-annexes_horizon-2026-2027_en.pdf\" rel=\"noopener noreferrer\" target=\"_blank\">Annex E</a> of the Horizon Europe Work Programme General Annexes.</p><p><strong>Proposal page limits and layout:</strong> descr…"
    ],
    "esDA_IngestDate": [
      "2026-10-07T16:17:23.179+0200"
    ],
    "esDA_FirstIngestDate": [
      "2025-12-19T09:42:14.727+0100"
    ]
  }
};

/** A topic whose budget line is shared by three topics of the call. */
export const CREA_SHARED_HIT = {
  "reference": "52519621TOPICSen",
  "url": "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/CREA-MEDIA-2027-TVONLINE-1",
  "summary": "TV and online content Animation projects",
  "language": "en",
  "metadata": {
    "type": [
      "1"
    ],
    "status": [
      "31094502"
    ],
    "identifier": [
      "CREA-MEDIA-2027-TVONLINE-1"
    ],
    "callIdentifier": [
      "CREA-MEDIA-2027-TVONLINE"
    ],
    "callTitle": [
      "TV and online content"
    ],
    "callccm2Id": [
      "52519728"
    ],
    "ccm2Id": [
      "52519621"
    ],
    "title": [
      "TV and online content Animation projects"
    ],
    "deadlineDate": [
      "2027-02-10T00:00:00.000+0000",
      "2027-09-15T00:00:00.000+0000"
    ],
    "startDate": [
      "2026-09-30T00:00:00.000+0000"
    ],
    "deadlineModel": [
      "multiple cut-off"
    ],
    "frameworkProgramme": [
      "43251814"
    ],
    "programmePeriod": [
      "2021 - 2027"
    ],
    "programmeDivision": [
      "43435064"
    ],
    "budgetOverview": [
      "{\"budgetYearsColumns\":[\"2027\"],\"budgetTopicActionMap\":{\"115584\":[{\"action\":\"CREA-MEDIA-2027-TVONLINE-1 - CREA-LS CREA Lump Sum Grants\",\"expectedGrants\":0,\"minContribution\":0,\"maxContribution\":0,\"budgetYearMap\":{\"2027\":\"23300000\"},\"plannedOpeningDate\":\"2026-09-30\",\"deadlineModel\":\"multiple cut-off\",\"deadlineDates\":[\"2027-02-10\",\"2027-09-15\"]},{\"action\":\"CREA-MEDIA-2027-TVONLINE-2 - CREA-LS CREA Lump Sum Grants\",\"expectedGrants\":0,\"minContribution\":0,\"maxContribution\":0,\"budgetYearMap\":{\"2027\":\"23300000\"},\"plannedOpeningDate\":\"2026-09-30\",\"deadlineModel\":\"multiple cut-off\",\"deadlineDates\":[\"2027-02-10\",\"2027-09-15\"]},{\"action\":\"CREA-MEDIA-2027-TVONLINE-3 - CREA-LS CREA Lump Sum Grants\",\"expectedGrants\":0,\"minContribution\":0,\"maxContribution\":0,\"budgetYearMap\":{\"2027\":\"23300000\"},\"plannedOpeningDate\":\"2026-09-30\",\"deadlineModel\":\"multiple cut-off\",\"deadlineDates\":[\"2027-02-10\",\"2027-09-15\"]}]}}"
    ],
    "actions": [
      "[{\"types\":[{\"typeOfAction\":\"CREA-LS CREA Lump Sum Grants\",\"typeOfMGA\":[{\"id\":43249888,\"abbreviation\":\"CREA-AG-LS\",\"description\":\"CREA Lump Sum Grant\"}]}],\"status\":{\"id\":31094502,\"abbreviation\":\"Open\",\"description\":\"Open\"},\"plannedOpeningDate\":\"2026-09-30\",\"submissionProcedure\":{\"id\":31094506,\"abbreviation\":\"multiple cut-off\",\"description\":\"multiple cut-off\"},\"deadlineDates\":[\"2027-02-10\",\"2027-09-15\"]}]"
    ],
    "latestInfos": [
      "[{\"approvalDate\":\"\",\"lastChangeDate\":\"2026-09-30T16:20:30.928\",\"content\":\"The submission session is now available for: CREA-MEDIA-2027-TVONLINE-1, CREA-MEDIA-2027-TVONLINE-2, CREA-MEDIA-2027-TVONLINE-3\"}]"
    ],
    "links": [
      "[{\"callIdentifier\":\"CREA-MEDIA-2027-TVONLINE\",\"criterionCode\":\"CREA-LS\",\"criterionDescription\":\"CREA Lump Sum Grants\",\"url\":\"https://ec.europa.eu/research/participants/submission/manage/screen/submission/create-draft/46493?topic\\u003dCREA-MEDIA-2027-TVONLINE-1\",\"startDate\":\"1790726400000\",\"endDate\":\"1820966400000\",\"mgaDescription\":\"CREA Lump Sum Grant\",\"mgaCode\":\"CREA-AG-LS\"}]"
    ],
    "typesOfAction": [
      "CREA Lump Sum Grants"
    ],
    "descriptionByte": [
      "<p class=\"topicdescriptionkind\">Scope:</p><p>The objective of the support to TV and online content is to increase the capacity of audiovisual producers to develop and produce strong projects with significant potential to circulate throughout Europe and beyond, and to facilitate European and international co-productions within the television and online sector.</p><p>The action aims to strengthen the independence of producers in relation to broadcasters and digital platforms, to enhance collaboration between operators, including independent producers, broadcasters, digital platforms and sales agents, from different countries participating in the MEDIA strand, including from low capacity countr…"
    ],
    "topicConditions": [
      "<div class=\"eui-u-mt-l>\"><h4>Conditions</h4><div><h4>1. Admissibility conditions: Proposal page limit and layout</h4><div class=\"eui-u-mt-s\"><p>described in the <u><a href=\"https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/crea/wp-call/2027/call-fiche_crea-media-2027-tvonline_en.pdf\" rel=\"noopener noreferrer\" target=\"_blank\">call document</a></u>.</p><p><strong>Proposal page limits and layout:</strong> described in Part B of the Application Form available in the Submission System.</p></div></div><div><h4>2. Eligible countries</h4><div class=\"eui-u-mt-s\"><p>described in the <u>…"
    ],
    "esDA_IngestDate": [
      "2026-10-05T12:58:50.327+0200"
    ],
    "esDA_FirstIngestDate": [
      "2026-09-30T11:21:55.218+0200"
    ]
  }
};

/** A topic whose budget overview gives 0 for expected grants and contributions. */
export const ESF_ZERO_HIT = {
  "reference": "52256539TOPICSen",
  "url": "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/ESF-2027-PEP-ENGAGEMENT",
  "summary": "Structured dialogue with people with lived experience of poverty",
  "language": "en",
  "metadata": {
    "type": [
      "1"
    ],
    "status": [
      "31094502"
    ],
    "identifier": [
      "ESF-2027-PEP-ENGAGEMENT"
    ],
    "callIdentifier": [
      "ESF-2027-PEP-ENGAGEMENT"
    ],
    "callTitle": [
      "Structured dialogue with people with lived experience of poverty"
    ],
    "callccm2Id": [
      "52256547"
    ],
    "ccm2Id": [
      "52256539"
    ],
    "title": [
      "Structured dialogue with people with lived experience of poverty"
    ],
    "deadlineDate": [
      "2026-10-29T00:00:00.000+0000"
    ],
    "startDate": [
      "2026-09-01T00:00:00.000+0000"
    ],
    "deadlineModel": [
      "single-stage"
    ],
    "frameworkProgramme": [
      "43254019"
    ],
    "programmePeriod": [
      "2021 - 2027"
    ],
    "programmeDivision": [
      "43254027"
    ],
    "budgetOverview": [
      "{\"budgetYearsColumns\":[\"2027\"],\"budgetTopicActionMap\":{\"115322\":[{\"action\":\"ESF-2027-PEP-ENGAGEMENT - ESF-PJG ESF Project Grants\",\"expectedGrants\":0,\"minContribution\":0,\"maxContribution\":0,\"budgetYearMap\":{\"2027\":\"900000\"},\"plannedOpeningDate\":\"2026-09-01\",\"deadlineModel\":\"single-stage\",\"deadlineDates\":[\"2026-10-29\"]}]}}"
    ],
    "actions": [
      "[{\"types\":[{\"typeOfAction\":\"ESF-PJG ESF Project Grants\",\"typeOfMGA\":[{\"id\":43252140,\"abbreviation\":\"ESF-AG\",\"description\":\"ESF Action Grant Budget-Based\"}]}],\"status\":{\"id\":31094502,\"abbreviation\":\"Open\",\"description\":\"Open\"},\"plannedOpeningDate\":\"2026-09-01\",\"submissionProcedure\":{\"id\":31094504,\"abbreviation\":\"single-stage\",\"description\":\"single-stage\"},\"deadlineDates\":[\"2026-10-29\"]}]"
    ],
    "latestInfos": [
      "[{\"approvalDate\":\"\",\"lastChangeDate\":\"2026-09-01T00:01:04.738\",\"content\":\"The submission session is now available for: ESF-2027-PEP-ENGAGEMENT\"},{\"approvalDate\":\"\",\"lastChangeDate\":\"2026-08-19T10:07:38.150\",\"content\":\"<p><strong>Registration for the info session - ESF-2027-PEP-ENGAGEMENT</strong></p><p>The Directorate-General for Employment, Social Affairs and Inclusion is organising an info session for the forthcoming call for proposals “<a href=\\\"https://ec.europa.eu/info/funding-tenders/opportunities/portal/scr\"}]"
    ],
    "links": [
      "[{\"callIdentifier\":\"ESF-2027-PEP-ENGAGEMENT\",\"criterionCode\":\"ESF-PJG\",\"criterionDescription\":\"ESF Project Grants\",\"url\":\"https://ec.europa.eu/research/participants/submission/manage/screen/submission/create-draft/45951?topic\\u003dESF-2027-PEP-ENGAGEMENT\",\"startDate\":\"1788220800000\",\"endDate\":\"1793232000000\",\"mgaDescription\":\"ESF Action Grant Budget-Based\",\"mgaCode\":\"ESF-AG\"}]"
    ],
    "typesOfAction": [
      "ESF Project Grants"
    ],
    "descriptionByte": [
      "<p class=\"topicdescriptionkind\">Expected Outcome:</p><p>The primary aim of this action is to <strong>create the conditions for a sustained dialogue</strong> between policymakers and individuals with lived experience of poverty, ensuring that those directly affected by poverty and/or social exclusion have a real and influential voice in the decisions that shape their lives.</p><p>A core objective is to <strong>empower participants by providing them with the tools, confidence, and platforms needed to engage effectively </strong>in discussions on challenges related to combating poverty and social inclusion. This will come together with building trust and breaking down barriers between instituti…"
    ],
    "topicConditions": [
      "<div class=\"eui-u-mt-l>\"><h4>Conditions</h4><div><h4>1. Admissibility conditions: Proposal page limit and layout</h4><div class=\"eui-u-mt-s\"><p>All admissibility conditions are described in the <a href=\"https://ec.europa.eu/info/funding-tenders/opportunities/docs/2021-2027/esf/wp-call/2027/call-fiche_esf-2027-pep-engagement_en.pdf\" rel=\"noopener noreferrer\" target=\"_blank\">Call document</a>.</p><p>Applications must be submitted <strong>before the call deadline</strong> and <strong>electronically</strong> via the Funding &amp; Tenders Portal Electronic Submission System. Paper submissions are NOT possible.</p><p>Applications (including annexes and supporting documents) must be submitted using…"
    ],
    "esDA_IngestDate": [
      "2026-09-18T16:22:38.515+0200"
    ],
    "esDA_FirstIngestDate": [
      "2026-08-18T00:00:04.391+0200"
    ]
  }
};

/** The facet endpoint's answer, trimmed to the frameworkProgramme facet. */
export const FACET_PROGRAMME = {
  "apiVersion": "2.157",
  "terms": "*",
  "facets": [
    {
      "apiVersion": "2.157",
      "name": "frameworkProgramme",
      "rawName": "frameworkProgramme",
      "database": "SEDIA",
      "count": 1,
      "values": [
        {
          "apiVersion": "2.157",
          "rawValue": "43108390",
          "value": "Horizon Europe (HORIZON)",
          "count": 6393
        }
      ]
    }
  ]
};

/** A search response envelope as the API sends it. */
export function searchBody(results: unknown[], totalResults: number, pageNumber = 1, pageSize = 100): Record<string, unknown> {
  return {
    apiVersion: "2.157",
    terms: "***",
    responseTime: 18,
    totalResults,
    pageNumber,
    pageSize,
    sort: "relevance",
    groupByField: "sortStatus",
    queryLanguage: { language: "en", probability: 0 },
    bestBets: [],
    results,
    warnings: [],
  };
}
