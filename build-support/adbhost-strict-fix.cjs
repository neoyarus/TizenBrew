'use strict';

// adbhost 0.0.2 assigns an undeclared packet in _onPacket. Bundling followed
// by Babel strict mode turns its first incoming CNXN into a ReferenceError.
// Patch that exact dependency function in the AST; retain strict everywhere.
module.exports = function adbhostStrictFix({ types }) {
  return {
    name: 'adbhost-local-packet',
    pre() { this.adbhostPacketFixes = 0; },
    visitor: {
      AssignmentExpression(astPath, state) {
        const node = astPath.node;
        if (!types.isMemberExpression(node.left) || node.left.computed || !types.isIdentifier(node.left.property, { name: '_onPacket' }) || !types.isFunctionExpression(node.right)) return;
        const statements = node.right.body.body;
        const first = statements[0];
        if (!types.isExpressionStatement(first) || !types.isAssignmentExpression(first.expression, { operator: '=' })) return;
        const assignment = first.expression;
        if (!types.isIdentifier(assignment.left, { name: 'packet' }) || !types.isMemberExpression(assignment.right) || assignment.right.computed || !types.isThisExpression(assignment.right.object) || !types.isIdentifier(assignment.right.property, { name: '_packet' })) return;
        const declaration = types.variableDeclaration('var', [types.variableDeclarator(types.identifier('packet'), assignment.right)]);
        types.inheritsComments(declaration, first);
        statements[0] = declaration;
        state.adbhostPacketFixes++;
      }
    },
    post() {
      if (this.adbhostPacketFixes !== 1) throw new Error('Expected exactly one adbhost 0.0.2 packet declaration fix; review the bundled dependency');
    }
  };
};
