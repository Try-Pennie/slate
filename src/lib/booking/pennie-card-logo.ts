/**
 * The Pennie logo the reminder's contact card carries when the advisor has no photo,
 * or theirs cannot be fetched (#2980, Dan 2026-10-01).
 *
 * The Pennie mark (`logo-mark.svg` from the Pennie Design System assets) in beige
 * (`--pennie-beige`) centred on a solid navy square (`--pennie-navy`), the system's
 * own pairing for the mark on a dark band. 256px square to match the advisor photos,
 * opaque, since a transparent background reads as black in an iPhone contact circle,
 * and with room around the mark so the circle crop never clips it.
 *
 * Bundled with the Worker as a constant, so the fallback needs no fetch and can
 * never fail at send time. `scripts/test-pennie-card-logo.ts` proves it is a
 * complete, square, opaque PNG well under the card's photo cap. Rendered from the
 * SVG with Playwright's Chromium at 256 by 256 and a device scale of 1.
 */
import type { CardPhoto } from "./advisor-contact-card.ts";

export const PENNIE_CARD_LOGO: CardPhoto = {
  type: "PNG",
  base64: [
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAOeklEQVR4nOzdCVRV1R7H8T9qCAhcQVBTUdGcxRlFE5scctbkmWak",
  "Zi+18Bm+npkaDpmUU2Bo4jzhlDmkiaKGioqAMisODIKGgCjzKOE7NlAWKOC553D3//eptWq1bLHK+73n7L3P3qeGlXVHAuCqBgEw",
  "hgCANQQArCEAYA0BAGsIAFhDAMAaAgDWEACwhgCANQQArCEAYA0BAGsIAFhDAMAaAgDWEACwhgCANQQArCEAYA0BAGsIAFhDAMAa",
  "AgDWEACwhgCANQQArCEAYA0BAGsIAFhDAMAaAgDWEACwhgCANQQArCEAYA0BAGsIAFhDAMAaAgDWEACwhgCANQQArCEAYA0BAGsI",
  "AFhDAMAaAgDWEACwhgCANQQArCEAYA0BAGsIAFhDAMAaAgDWEACwhgCANQQArCEAYA0BAGsIAFhDAMAaAgDWEACwhgCANQQArCEA",
  "dZiYGLdqYd2iuXXz5o2bN2+qMTE2NDQwMDQ0MjAwMpL+apCXl5+dk5uTLf2Rl5aeERsXHxubcCMm/kZMXFpaBoFM9KysOxIoooNN",
  "mx62ney6d27T+oW6lnWospKS74aEXg66FB4afiU8IorgGSAA7bJuavVyHzu7Hp3tbDvXqmVEcsvMytp34OjWHfsTEn4mqDgEoBX1",
  "61kOHdx3yMDX2rVtQYo4e/6i164Dx0/6EVQEApCTkZHhkEGvjhw6wLabOv9Xf05M2rT1u737vbOzcwjKAQHIw9LCfILjv8aNGW5s",
  "XIvUVlBQsGvvYfdvNmZmZRM8EQJ4VtJd/uRJbw0b0k9f/zmqSlJT78+Zt/TkqfMEZUMAlVfP0sJlzvQB/fpQFXbY+6eFi93v308n",
  "KA0CqAw9Pb0Jjg4fOb2rjYkd2UnLCDNmLvI7F0jwD9U1ZvUJKqJVy2ab1y1/Y/jrVe2epyzSCtuIof0tLev4B4QUFRUR/AWuABUz",
  "e+aH744fTbop4fad9z+YFR1zk+AP1QjKRxrseh/crLuffknjRs/v2e7RoX1rgj8ggHJ5a/SwQ9+vb/GCNek4U1OTHVtW9u7VjeBX",
  "GAM8hcbU2H2Zy6SJY2rUEOTBQek/ZMSwAdej46Jj4ok9BPAkja0afLdjdacO7Ug4/fvah0VcTbjF/Qki3AKVqX27Vvt2ezZsIOYX",
  "hHQdWPPNIowHEEDpXupjt3PLytoaUxJXzZo1N61dJg3uiTEEUAqHkQPXrXI1NDQg0Wk0Jp4ei58TZXhTCRgD/N3wIf2Wus6W1nqJ",
  "BzMzjYlJrTNnma4TI4DH2L/Y/ZuvF1SrxuvC2KlD2+DQyIRbicQPboH+1KVT+01rl1avXp34WbJ4tqmJMfGDK8DvpLGg1yY3aVxI",
  "LNWqZSStkfme9idmcAV4pK5Fne2b3KRPADE2dvSwDjZtiBkE8OjZ5lXun9era0HsuS6cyW38gwBoxn/e69xJwLXeSmjVstkYhyHE",
  "CfcAevfqNvX9twn+4PTBBFbTAKxPhmvwfL2VK+ZTFRAeEXX+QnDgxdCAoLCCgoKSf962TYsetp16du/S3bajMtvt61rWGTms/979",
  "3sQD6w0xu7Z5dOtiQ+o5csz34A/HLwSF5OTkPvUXd+1s88pLPSc4jjIw0O4S9c34230HjSMe+E6DDh/af6KjA6nk2rWYaTPmbdi8",
  "O+7mrQcPHpTnX7mTlHL+wqXv9x+tY27WulVz0pratU2jrsXExiUQA0wDkKa9PT0Wq7KlXfqyd126+pO5XybeSaaKy8nN9TnpdyEw",
  "tGsXG+mTStpRU/+5H71/IgaYDoKnfzjxWY6nrbSQsMv9Br29bcc+ejbSaEG6S/HafZC0o99r9hoNi1URjlcAadF3mets5Se8Iy9f",
  "c5zonJ6ZSTI5ddrfwsLcRjvP9CcmJkdEXiXRcQzg66UuTZs0ImWFRUS9M2mGdANDsvI97V+3rkX7dq1IbtKk0/cM5oLY3QJJq/32",
  "vWxJWdK8iuO7zlo6sHbu/GXSbBLJzbZrBw47ItgFMPXfSk/wPXz40HnmwtzcPNKaz+YvT8+Q7c6qhLpzxMrgFYB059P31d6krI2b",
  "90REXiNtysjMmu2yhOTWw7YziY5XAFPeG6fwVq/4W4muy1aT9vmc8JP97RjS8jOJjlEA0rzniGH9SVnfem4lpaxYuYFk1a5tSxId",
  "owAcRg1W+HCre/fSlXyo5kZ03Dn/SySfmvr6Vg0FnyTkFMCIgaQsbx/5J2ee8hOPyvwTrZs1IaFxCaB925aNrRqQsryPnSJlHTt5",
  "hmRl3UTwU4O4BDBsSD9SljTrHxAUSspKS8uQd8bJuqnSK4YK4xLAcMUDiLxyndQQHinnq7PrmJuR0FhsiOll16VOHaV/I2Ni1Tl7",
  "OTbuFslHI/ThkMQkgJfte5Li0tMzSA1JySkkH3MzBKD7enQXf0WzhLwvhDQz05DQxA/A1MS4XdsWpDg9Uud00UxZH7kzqCn483Di",
  "B6DW17+eSgfsGBvJuc0tN0+Lz/BVBeIHYNe9E6nh4cOHpAZ5b1qysrTyCHfVIX4Atl3VeaJLrQPWmzdrTPKRfQdPVSN+APJ+IMpP",
  "rStA65ZyHhiRnY0AdFmjBvXVOvBZrSuAXQ85xzzJKakkNMEDaNKkIalElStA61YvWFrIedqFWst5ihE8gGbWqj3MqMoVYLTDYJJV",
  "nKzrylWQ4AE0Ff1Zrr8yMTEeNeJ1klVMHK4Auqxxw+dJJcrfAk0aP7qWrIsA+fn5cTdxBdBlxuq990rhWyBLC/NJE94kWYWGy/lg",
  "adUkeABGhobEw4LPZsh+jI9/QAiJTvAAahmJf7STxPGtN/r3tSe5BQYhAB1naCT+FaCXXde5s5xIbgWFhcGhl0l0wt8CCX4F6GjT",
  "xtNjsTZeauR7yv+XX34h0Qm+JdJEvUGwArNAfV/t7bXZTUsneO47eJQYEPwKUFBQIOqjENM/nOg0dbyWfkpmZhaTl2YLHkBOTp54",
  "L39v1bLZ4oUzO2rzpdb7D/mo9TCfwgQPICsn19y8NqlBGx+gPvY93hk78uWXtL7FedeeQ8SD4AHk51b1DU019fUXzpsRHBJ5KSQy",
  "OuZmqb+mS6f2Pe26jho5sHEjJRa2fU743YiOIx5EvwWq+jv69PRGjRg46tdjG6URS3RMwq3biTfjb5ub1W7QoJ6VVYMmih9o57Fm",
  "C7EheAC6tZ9DGq60a9tClS38JXxPnb8SdYPYEDyAO0lyHpLDwdceG4kTwQOQ7iVIJeWcoKxWTZ2NY6Xasn0vq69/QgBQ4m7qveVu",
  "64kZwQOIT0AA5TV/kZvwpwD9k+hXgJsIoFyO+pw+dlzmdwvoBMGfBSp88ODWz0mkhnIuhBUXq7/gKk0VzPrsK2JJ/PcDhEdcITXo",
  "yiBYCtXpIxctvcS76hM/gMCgMFKDrlwBVq3ZGhYh/tbHsoh/MlxQcDipQSeuANKtvxuzif+/Ef8KcP16bHaO4Of7VY7fuaDpHy8g",
  "3li8I+xCYDDB44JDIic7zeaw5+vJeASgxukGVXkMEBAUMnHy/woLC4k9FgEcOeqr/PaOKjsGOPHT2fHv/TcHt4W/YhFAyt17Z/0v",
  "EhB9t+/IlGlzioq43/mU4PKe4H0HWGzxfgLpK/9Tl68+5brgVRYWb4mUSOv8ubl5RgyOCSpVeMRVJ2eXxDvJBI/jcgWQBnwHDh+n",
  "qkeBscmKlevfGDMZn/5ScQlAsnP3QVJQOYfdWh2dS0u8/Yc4rvbcRlAGRgFEXY32Ox9ESlF3Fig/P3/xklUOY6fGxiUQlI3LGOA3",
  "a9d72feyJaEVFBTs2nvYc61XSuo9gqfhFYB/QEhE5FWb9q1JRNK3/s49hzw3eKWmphGUD68AJN+u277afREJpLi4+EJg6KEjx4/6",
  "nMnKyiaoCHYB+Jzwk26Lm1lr/eXB2n4UIj0981JoRID00f/xxN3U+wSVwi4AyaKvPDauWUJaVs5BcPlPt01OuXsjOj46Ju7ylRvB",
  "YZfjsd9fDhwDOOMXcML3bN9XepM2lfMKIN2423QbYFZbY2ZmWltjKv2NRmOqqW1aWFCYk52bnZubnZ2blpYeHRvPdtOWVnEMQLJg",
  "kbv9i91r6uuT1pT/qz0vL1/6EwtVqmC0DvBXd5JS1m/cScAe0wDo0V7YbSl3MVPOHd8ACh88cJ75uTSHSMAY3wAkAYEh7qs2EzDG",
  "OgB6dCO05UIAdgzzxT0AiZPzvFQsJHGFACg9I9PJ2YXkxuQlc7oOATxyMThimvM8eT+y2n5NKsgCAfzO2+fU/C/cCJhBAH/y2nlg",
  "zTovAk4QwGOWua09cMiHgA0E8Hcfz/pi30EZzlDBIFgnIIBSzJzt+u3a7fRsMAjWCQigdMvd17ksXIFvceEhgDLt2H1wyrQ5BThB",
  "VmgI4ElO+p4bN3565TYc4uqhExDAU4SGXxk8YkJwSCRVEMYAOgEBPN39tIwx70yTlgjwpS4eBFAuxcXF0hLBpCmf4G1LgkEAFXDm",
  "bED/QW8f+MEHlwJhIICKSUm99/GnXziMnRp1NZpA9yGAygiLiBo6atKsuV/iRCpdhwAqb+9+71cGjF2ywvP+/XQC3YQAnkl+fv7a",
  "DTv69HsTGegoBCCDkgxcl60uuSnCQFknVNeY1SeQQ1FRUUjo5Q2bdycmpdSoUeN2YnLQxTCCqk3PyrojAXDF9GxQgN8gAGANAQBr",
  "CABYQwDAGgIA1hAAsIYAgDUEAKwhAGANAQBrCABYQwDAGgIA1hAAsIYAgDUEAKwhAGANAQBrCABYQwDAGgIA1hAAsIYAgDUEAKwh",
  "AGANAQBrCABYQwDAGgIA1hAAsIYAgDUEAKwhAGANAQBrCABYQwDAGgIA1hAAsIYAgDUEAKwhAGANAQBrCABYQwDAGgIA1hAAsIYA",
  "gDUEAKwhAGANAQBrCABYQwDAGgIA1hAAsIYAgDUEAKwhAGANAQBrCABYQwDAGgIA1hAAsIYAgDUEAKwhAGANAQBr/wcAAP//tjtK",
  "WAAAAAZJREFUAwD9NWt+0XpsOAAAAABJRU5ErkJggg==",
  ].join(""),
};
