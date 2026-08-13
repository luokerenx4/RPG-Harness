import React from "react";
import { Box, Text } from "ink";

interface Props {
  endingId?: string;
  endingTitle?: string;
  reason?: string;
}

export function EndedStage({ endingId, endingTitle, reason }: Props) {
  return (
    <Box
      flexGrow={1}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <Text color="gray">— 完 —</Text>
      {endingTitle ? (
        <Box marginTop={1}>
          <Text>{endingTitle}</Text>
        </Box>
      ) : null}
      {endingId ? <Text dimColor>{endingId}</Text> : null}
      {reason ? (
        <Box marginTop={1}>
          <Text dimColor>{reason}</Text>
        </Box>
      ) : null}
      <Box marginTop={2}>
        <Text dimColor>感谢游玩。按 Esc 回主菜单。</Text>
      </Box>
    </Box>
  );
}
