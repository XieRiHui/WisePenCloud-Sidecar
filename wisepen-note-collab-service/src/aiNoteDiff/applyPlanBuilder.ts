import { ApplyOperation, NoteXmlBundle, PatchOperation } from './types';

export function buildApplyOperations(
  operations: PatchOperation[],
  bundle: NoteXmlBundle,
): ApplyOperation[] {
  return operations.map((operation) => {
    if ('target' in operation) {
      return {
        ...operation,
        targetInfo: bundle.targetIndex.targets[operation.target],
      };
    }
    return {
      ...operation,
      anchorInfo: bundle.targetIndex.targets[operation.anchor],
    };
  });
}
