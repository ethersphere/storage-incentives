import chaiModule from 'chai';
import { chaiEthers } from 'chai-ethers';

chaiModule.use(chaiEthers);

export const expect = chaiModule.expect;
export default chaiModule;
