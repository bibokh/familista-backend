# Club Design Studio — privacy notes: DRAFT FOR QUALIFIED REVIEW

> **Not legal advice and not in force.** A working draft prepared from the code, so that counsel reviews facts rather
> than assumptions. Square brackets are for the Owner and counsel. Where the platform does not yet do something the law
> may require, this draft says so in **Gaps**: those are decisions and engineering work before launch, not wording.

## 1. Roles (to be confirmed by counsel)

- For a club's design data, rosters and requests, the **club** decides why and how they are used; Familista provides the
  service. The working assumption is that the club is the **controller** and Familista the **processor** for that data,
  under a data processing agreement [to be drafted].
- For its own accounts, security logs and the brokering of quotations, Familista acts as [controller — to confirm].
- Legal entity, address, representative and DPO: [to complete].

## 2. What the studio keeps, from the code

| Data | Where | Personal data? | Who sees it | How long |
|---|---|---|---|---|
| Designs and every saved version | `DesignProject`, `DesignRevision` | Rarely (a name typed into a design) | The club's administrators and managers; the Owner only for platform designs | Versions are never edited; a design is **archived**, not deleted, by the club |
| Club colours and logos | `DesignBrandKit`, `DesignBrandAsset` | No (club marks) | The club | Archived, not deleted |
| Team rosters: names to print, numbers, sizes, sets | `DesignRoster` | **Yes**: players' names; sizes may reveal age group (youth sizes) | The club | Deletable by the club once archived |
| Collections and their order sheets | `DesignCollection`, `DesignCollectionItem` | Through the roster | The club | Deletable by the club |
| Review comments and approvals | `DesignReviewComment`, `DesignApproval` | Staff names (author, approver); comment text | The club | Approvals are **append-only** (the database refuses changes) |
| Requests for quotation: a **frozen specification** with the roster's entries | `ManufacturingRequest.spec` | **Yes**: the roster as submitted | The club; the Owner (to broker); the supplier receives the production sheet from the Owner | **Never changed** (database trigger); no deletion path |
| Quotations and the order history | `ManufacturingQuote`, `ManufacturingRequestEvent` | Supplier contacts; staff notes | The club (published quotations only); the Owner | Append-only history |
| Supplier records | `ManufacturingSupplier` | Contact e-mail of a person at the supplier | The Owner only | Until removed by the Owner [policy to set] |
| Audit log of design and manufacturing actions | `PlatformAuditLog` | Who did what; **never** a comment's text, a name, a number or a size | Platform administrators | [retention to set] |

Squad names imported from the platform's player records are surname and number only (`squadNames`).

## 3. Who it goes to

- **Suppliers.** When the Owner brokers an order, the production sheet (names, numbers, sizes) is shared with the supplier
  making it, by the Owner. Suppliers may be outside the club's country: [transfer mechanism to decide per supplier
  country]. The console tells the Owner to share it with that supplier only.
- **Sub-processors** of the platform (hosting, database, backups): [list to complete from the infrastructure in use].
- Nobody else. Clubs never see each other's data (row-level security, tested).

## 4. Gaps before launch (decisions and engineering, not wording)

1. **Erasure.** There is no path to erase or anonymise a person's name from a frozen request specification, an archived
   design, or an append-only history. Decide the retention period for each, and build erasure or anonymisation that
   keeps the record's integrity (for example, replacing names in a closed request's specification after delivery plus
   [N] months).
2. **Children.** Rosters can hold youth players' names and sizes. Confirm the lawful basis the club relies on, and
   whether parental consent or a separate notice is required in the clubs' jurisdictions.
3. **Retention periods** for every row above, and for audit logs and backups.
4. **Supplier transfers.** A data processing agreement with each supplier that receives a production sheet, and the
   transfer mechanism for suppliers abroad.
5. **Notice to players.** Clubs need a short text telling players that their name and size are used to make kit and
   shared with the maker: [template to draft].
