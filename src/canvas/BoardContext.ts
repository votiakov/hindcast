import { createContext, useContext } from 'react';
import type { BoardId } from '../sim/store';

export const BoardContext = createContext<BoardId>('main');
export const useBoardId = () => useContext(BoardContext);
