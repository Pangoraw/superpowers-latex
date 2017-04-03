/// <reference path="../api/LatexAPIPlugin.d.ts" />

import * as OT from "operational-transform";
import * as mkdirp from "mkdirp";
import * as dummy_fs from "fs";
import * as dummy_path from "path";

// Since we're doing weird things to the fs module,
// the code won't browserify properly with brfs
// so we'll only require them on the server-side
let serverRequire = require;

let fs: typeof dummy_fs;
let path: typeof dummy_path;
let jade: any;
let latex: any;
if ((<any>global).window == null) {
  fs = serverRequire("fs");
  path = serverRequire("path");
  jade = serverRequire("jade");
  latex = serverRequire("latex");
}

type EditTextCallback = SupCore.Data.Base.ErrorCallback & ((err: string, ack: any, operationData: OperationData, revisionIndex: number) => void);
type ApplyDraftChangesCallback = SupCore.Data.Base.ErrorCallback;

interface LatexAssetPub {
  text: string;
  draft: string;
  revisionId: number;
}

export default class LatexAsset extends SupCore.Data.Base.Asset {
  static schema: SupCore.Data.Schema = {
    text: { type: "string" },
    draft: { type: "string" },
    revisionId: { type: "integer" }
  };

  pub: LatexAssetPub;
  document: OT.Document;
  hasDraft: boolean;

  constructor(id: string, pub: LatexAssetPub, server: ProjectServer) {
    super(id, pub, LatexAsset.schema, server);
  }

  init(options: any, callback: Function) {
    this.pub = {
      text: "",
      draft: "",
      revisionId: 0
    };

    super.init(options, callback);
  }

  setup() {
    this.document = new OT.Document(this.pub.draft, this.pub.revisionId);
    this.hasDraft = this.pub.text !== this.pub.draft;
  }

  restore() {
    if (this.hasDraft) this.emit("setBadge", "draft", "info");
  }

  load(assetPath: string) {
    let pub: LatexAssetPub;
    fs.readFile(path.join(assetPath, "document.latex"), { encoding: "utf8" }, (err, text) => {
      fs.readFile(path.join(assetPath, "draft.latex"), { encoding: "utf8" }, (err, draft) => {
        pub = { revisionId: 0, text, draft: (draft != null) ? draft : text };

        pub.draft = pub.draft.replace(/\r\n/g, "\n");
        pub.text = pub.text.replace(/\r\n/g, "\n");

        this._onLoaded(assetPath, pub);
      });
    });
  }

  save(assetPath: string, callback: (err: Error) => any) {
    fs.writeFile(path.join(assetPath, "document.latex"), this.pub.text, { encoding: "utf8" }, (err) => {
      if (err != null) { callback(err); return; }

      if (this.hasDraft) {
        fs.writeFile(path.join(assetPath, "draft.latex"), this.pub.draft, { encoding: "utf8" }, callback);
      } else {
        fs.unlink(path.join(assetPath, "draft.latex"), (err) => {
          if (err != null && err.code !== "ENOENT") { callback(err); return; }
          callback(null);
        });
      }
    });
  }

  serverExport(buildPath: string, assetsById: { [id: string]: LatexAsset }, callback: (err: Error, writtenFiles: string[]) => void) {
    let pathFromId = this.server.data.entries.getPathFromId(this.id);
    if (pathFromId.lastIndexOf(".latex") === pathFromId.length - 5) pathFromId = pathFromId.slice(0, -5);
    let outputPath = `${buildPath}/${pathFromId}.pdf`;
    let parentPath = outputPath.slice(0, outputPath.lastIndexOf("/"));

    let latexStream = latex(this.pub.text);

    mkdirp(parentPath, () => {
      let pdfFile = fs.createWriteStream(outputPath, {flags: "w", encoding: "utf-8", mode: 0o666});
      latexStream.pipe(pdfFile);

      pdfFile.on("finish", function(err: any) {
        callback(err, [ `${pathFromId}.pdf` ]);
      });
    });
  }

  server_editText(client: any, operationData: OperationData, revisionIndex: number, callback: EditTextCallback) {
    if (operationData.userId !== client.id) { callback("Invalid client id"); return; }

    let operation = new OT.TextOperation();
    if (!operation.deserialize(operationData)) { callback("Invalid operation data"); return; }

    try { operation = this.document.apply(operation, revisionIndex); }
    catch (err) { callback("Operation can't be applied"); return; }

    this.pub.draft = this.document.text;
    this.pub.revisionId++;

    callback(null, null, operation.serialize(), this.document.getRevisionId() - 1);

    if (!this.hasDraft) {
      this.hasDraft = true;
      this.emit("setBadge", "draft", "info");
    }
    this.emit("change");
  }

  client_editText(operationData: OperationData, revisionIndex: number) {
    let operation = new OT.TextOperation();
    operation.deserialize(operationData);
    this.document.apply(operation, revisionIndex);
    this.pub.draft = this.document.text;
    this.pub.revisionId++;
  }

  server_applyDraftChanges(client: any, callback: ApplyDraftChangesCallback) {
    this.pub.text = this.pub.draft;

    callback(null);

    if (this.hasDraft) {
      this.hasDraft = false;
      this.emit("clearBadge", "draft");
    }

    this.emit("change");
  }

  client_applyDraftChanges() { this.pub.text = this.pub.draft; }
}
