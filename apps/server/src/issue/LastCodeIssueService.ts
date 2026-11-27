import { selectLastCodeIssueRepository } from "@t3tools/source-control-core/shared/definition";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as IssueService from "./IssueService.ts";

export const layer = IssueService.layerWithGitHostIdentity((identity) =>
  selectLastCodeIssueRepository(identity, sourceControlDefinitions),
);
