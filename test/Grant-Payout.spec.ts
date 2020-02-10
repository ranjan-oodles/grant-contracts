import Grant from "../build/Grant.json";
import GrantToken from "../build/GrantToken.json";
import GrantFactory from "../build/GrantFactory.json";
import chai from "chai";
import * as waffle from "ethereum-waffle";
import { Contract, Wallet, constants } from "ethers";
import { BigNumber } from "ethers/utils/bignumber";
import { Web3Provider, Provider } from "ethers/providers";
import { bigNumberify, randomBytes, solidityKeccak256, id } from "ethers/utils";
import { AddressZero } from "ethers/constants";

chai.use(waffle.solidity);
const { expect, assert } = chai;

describe("Grant", () => {
  const AMOUNTS = [1000];
  const TARGET_FUNDING = AMOUNTS.reduce((a, b) => a + b, 0);

  async function fixture(provider: any, wallets: Wallet[]) {
    const currentTime = (
      await provider.getBlock(await provider.getBlockNumber())
    ).timestamp;
    const [
      granteeWallet,
      donorWallet,
      managerWallet,
      secondDonorWallet,
      unknownWallet
    ] = wallets;
    const token: Contract = await waffle.deployContract(
      donorWallet,
      GrantToken,
      ["Grant Token", "GT", 18]
    );
    const grantWithToken: Contract = await waffle.deployContract(
      granteeWallet,
      Grant,
      [
        [granteeWallet.address],
        AMOUNTS,
        managerWallet.address,
        token.address,
        TARGET_FUNDING,
        currentTime + 86400,
        currentTime + 86400 * 2
      ],
      { gasLimit: 6e6 }
    );
    const grantWithEther: Contract = await waffle.deployContract(
      granteeWallet,
      Grant,
      [
        [granteeWallet.address],
        AMOUNTS,
        managerWallet.address,
        AddressZero,
        TARGET_FUNDING,
        currentTime + 86400,
        currentTime + 86400 * 2
      ],
      { gasLimit: 6e6 }
    );
    const grantFactory: Contract = await waffle.deployContract(
      donorWallet,
      GrantFactory,
      undefined,
      { gasLimit: 6e6 }
    );

    // Initial token balance.
    await token.mint(donorWallet.address, 1e6);

    const grantFromDonor: Contract = new Contract(
      grantWithToken.address,
      Grant.abi,
      donorWallet
    );
    const grantFromDonorWithEther: Contract = new Contract(
      grantWithEther.address,
      Grant.abi,
      donorWallet
    );
    const grantFromManager: Contract = new Contract(
      grantWithToken.address,
      Grant.abi,
      managerWallet
    );
    const grantFromManagerWithEther: Contract = new Contract(
      grantWithEther.address,
      Grant.abi,
      managerWallet
    );

    return {
      grantFactory,
      grantWithToken,
      grantWithEther,
      grantFromDonor,
      grantFromDonorWithEther,
      grantFromManager,
      grantFromManagerWithEther,
      token,
      granteeWallet,
      donorWallet,
      managerWallet,
      fundingExpiration: currentTime + 86400,
      contractExpiration: currentTime + 86400 * 2,
      provider,
      secondDonorWallet,
      unknownWallet
    };
  }

  describe("Token", () => {
    describe("Approve Payout", () => {
      let _grantFromDonor: Contract;
      const _fundAmount = 500;
      const _payoutAmount = _fundAmount;
      let _grantFromManager: Contract;
      let _granteeWallet: Wallet;
      let _unknownWallet: Wallet;

      before(async () => {
        const {
          token,
          grantFromDonor,
          grantFromManager,
          granteeWallet,
          unknownWallet
        } = await waffle.loadFixture(fixture);

        _grantFromDonor = grantFromDonor;
        _grantFromManager = grantFromManager;
        _granteeWallet = granteeWallet;
        _unknownWallet = unknownWallet;

        await token.approve(grantFromDonor.address, 1000);
        await (await _grantFromDonor.fund(_fundAmount)).wait();
      });

      it("should revert if someone other than manager tries to approve payout", async () => {
        await expect(
          _grantFromDonor.approvePayout(_fundAmount, _granteeWallet.address)
        ).to.be.revertedWith(
          "onlyManager::Permission Error. Function can only be called by manager."
        );
      });

      it("should revert if target funding != total funding", async () => {
        await expect(
          _grantFromManager.approvePayout(_fundAmount, _granteeWallet.address)
        ).to.be.revertedWith(
          "approvePayout::Status Error. Cannot approve if funding target not met."
        );
      });

      it("should the target funding  == total funding", async () => {
        const targetFunding = await _grantFromDonor.targetFunding();
        let totalFunding = await _grantFromDonor.totalFunding();
        await _grantFromDonor.fund(targetFunding - totalFunding);

        totalFunding = await _grantFromDonor.totalFunding();
        expect(targetFunding).to.be.eq(totalFunding);
      });

      it("should revert if value > target funding", async () => {
        const { targetFunding } = await _grantFromManager.grantees(
          _granteeWallet.address
        );
        await expect(
          _grantFromManager.approvePayout(
            targetFunding + 1,
            _granteeWallet.address
          )
        ).to.be.revertedWith(
          "approvePayout::Invalid Argument. value cannot exceed remaining allocation."
        );
      });

      it("should revert if address does not belongs to grantee", async () => {
        await expect(
          _grantFromManager.approvePayout(_payoutAmount, _unknownWallet.address)
        ).to.be.revertedWith(
          "approvePayout::Invalid Argument. value cannot exceed remaining allocation."
        );
      });

      it("should emit LogPayment on approve payment", async () => {
        await expect(
          _grantFromManager.approvePayout(_payoutAmount, _granteeWallet.address)
        )
          .to.emit(_grantFromManager, "LogPayment")
          .withArgs(_granteeWallet.address, _payoutAmount);
      });

      it("should update total payed of grantee and Grant", async () => {
        const totalPayedOfGrant = await _grantFromManager.totalPayed();

        const { totalPayed } = await _grantFromManager.grantees(
          _granteeWallet.address
        );

        expect(totalPayedOfGrant).to.be.eq(totalPayed);
        expect(totalPayed).to.be.eq(_payoutAmount);
      });

      // always at last
      it("should revert if grant is already cancelled", async () => {
        // await _grantFromDonor.fund(_fundAmount);
        await _grantFromManager.cancelGrant();
        await expect(
          _grantFromManager.approvePayout(_fundAmount, _granteeWallet.address)
        ).to.be.revertedWith(
          "approvePayout::Status Error. Cannot approve if grant is cancelled."
        );
      });
    });

    describe("Grantee balance", () => {
      let _grantFromDonor: Contract;
      const _fundAmount = 5e2;
      const _payoutAmount = _fundAmount;
      let _grantFromManager: Contract;
      let _granteeWallet: Wallet;
      let _token: Contract;

      before(async () => {
        const {
          token,
          grantFromDonor,
          grantFromManager,
          granteeWallet
        } = await waffle.loadFixture(fixture);

        _grantFromDonor = grantFromDonor;
        _grantFromManager = grantFromManager;
        _granteeWallet = granteeWallet;
        _token = token;

        await token.approve(grantFromDonor.address, TARGET_FUNDING);
        await _grantFromDonor.fund(TARGET_FUNDING);
      });

      it("should not be updated yet", async () => {
        let tokenBalance = await _token.balanceOf(_granteeWallet.address);
        expect(tokenBalance).to.eq(0);

        const { totalPayed } = await _grantFromManager.grantees(
          _granteeWallet.address
        );
        expect(0).to.eq(totalPayed);
      });

      it("should updated with token after approve payout", async () => {
        await _grantFromManager.approvePayout(
          _payoutAmount,
          _granteeWallet.address
        );

        let tokenBalance = await _token.balanceOf(_granteeWallet.address);
        expect(tokenBalance).to.eq(_payoutAmount);

        const { totalPayed } = await _grantFromManager.grantees(
          _granteeWallet.address
        );
        expect(_payoutAmount).to.eq(totalPayed);
      });
    });
  });

  describe("Ether", () => {
    describe("Grantee balance", () => {
      let _grantFromDonorWithEther: Contract;
      let _grantFromManagerWithEther: Contract;
      const _fundAmount = 5e2;
      const _payoutAmount = _fundAmount / 2;
      let _donorWallet: Wallet;
      let _granteeWallet: Wallet;
      let _provider: any;
      let _initialEtherBalance: any;

      before(async () => {
        const {
          grantFromDonorWithEther,
          grantFromManagerWithEther,
          donorWallet,
          granteeWallet,
          provider
        } = await waffle.loadFixture(fixture);

        _donorWallet = donorWallet;
        _granteeWallet = granteeWallet;
        _grantFromDonorWithEther = grantFromDonorWithEther;
        _grantFromManagerWithEther = grantFromManagerWithEther;
        _provider = provider;

        // Donor fund Ether
        await _donorWallet.sendTransaction({
          to: _grantFromDonorWithEther.address,
          value: 1e6
        });

        _initialEtherBalance = await _provider.getBalance(
          _granteeWallet.address
        );
      });

      it("should not be updated yet", async () => {
        const etherBalance = await _provider.getBalance(_granteeWallet.address);
        expect(_initialEtherBalance).eq(etherBalance);

        const { totalPayed } = await _grantFromManagerWithEther.grantees(
          _granteeWallet.address
        );
        expect(0).to.eq(totalPayed);
      });

      it("should updated with ether after approve payout", async () => {
        await _grantFromManagerWithEther.approvePayout(
          _payoutAmount,
          _granteeWallet.address
        );

        const { totalPayed } = await _grantFromManagerWithEther.grantees(
          _granteeWallet.address
        );
        expect(_payoutAmount).eq(totalPayed);

        const balanceAfterPayout = await _provider.getBalance(
          _granteeWallet.address
        );
        expect(_initialEtherBalance.add(_payoutAmount)).eq(balanceAfterPayout);
      });
    });
  });

  describe("When multiple grantee are involved", () => {
    const AMOUNTS = [1000, 500];
    const TARGET_FUNDING = AMOUNTS.reduce((a, b) => a + b, 0);

    async function fixtureWithMultipleGrantee(
      provider: any,
      wallets: Wallet[]
    ) {
      const currentTime = (
        await provider.getBlock(await provider.getBlockNumber())
      ).timestamp;

      const [
        granteeWallet,
        secondGranteeWallet,
        donorWallet,
        managerWallet,
        thirdPersonWallet
      ] = wallets;

      const token: Contract = await waffle.deployContract(
        donorWallet,
        GrantToken,
        ["Grant Token", "GT", 18]
      );

      const grantWithToken: Contract = await waffle.deployContract(
        granteeWallet,
        Grant,
        [
          [granteeWallet.address, secondGranteeWallet.address],
          AMOUNTS,
          managerWallet.address,
          token.address,
          TARGET_FUNDING,
          currentTime + 86400,
          currentTime + 86400 * 2
        ],
        { gasLimit: 6e6 }
      );

      // Initial token balance.
      await token.mint(donorWallet.address, 1e6);

      const grantFromDonor: Contract = new Contract(
        grantWithToken.address,
        Grant.abi,
        donorWallet
      );

      const grantFromManager: Contract = new Contract(
        grantWithToken.address,
        Grant.abi,
        managerWallet
      );
      return {
        grantWithToken,
        grantFromDonor,
        grantFromManager,
        token,
        granteeWallet,
        secondGranteeWallet,
        donorWallet,
        managerWallet,
        thirdPersonWallet,
        provider
      };
    }

    describe("Grantees' balance", () => {
      let _grantFromDonor: Contract;
      let _grantFromManager: Contract;
      let _granteeWallet: Wallet;
      let _secondGranteeWallet: Wallet;
      let _lastTotalPayedForGrantee: BigNumber;
      let _lastTotalPayedForSecondGrantee: BigNumber;

      before(async () => {
        const {
          token,
          grantFromDonor,
          grantFromManager,
          granteeWallet,
          secondGranteeWallet
        } = await waffle.loadFixture(fixtureWithMultipleGrantee);

        _grantFromDonor = grantFromDonor;
        _grantFromManager = grantFromManager;
        _granteeWallet = granteeWallet;
        _secondGranteeWallet = secondGranteeWallet;

        await token.approve(grantFromDonor.address, TARGET_FUNDING);
        await _grantFromDonor.fund(TARGET_FUNDING);

        let {
          totalPayed: initialTotalPayedForGrantee
        } = await _grantFromManager.grantees(_granteeWallet.address);
        _lastTotalPayedForGrantee = initialTotalPayedForGrantee;

        let {
          totalPayed: initialTotalPayedForSecondGrantee
        } = await _grantFromManager.grantees(_secondGranteeWallet.address);
        _lastTotalPayedForSecondGrantee = initialTotalPayedForSecondGrantee;
      });

      it("should be updated with initial approved amount", async () => {
        let approveAmount = 5e2;

        // for 1st Grantee
        const initialTotalPayedForGrantee = _lastTotalPayedForGrantee;
        await _grantFromManager.approvePayout(
          approveAmount,
          _granteeWallet.address
        );

        let {
          totalPayed: finalTotalPayedForGrantee
        } = await _grantFromManager.grantees(_granteeWallet.address);

        expect(initialTotalPayedForGrantee.add(approveAmount)).to.be.eq(
          finalTotalPayedForGrantee
        );
        _lastTotalPayedForGrantee = finalTotalPayedForGrantee;

        // for 2nd Grantee
        approveAmount = 250;

        const initialTotalPayedForSecondGrantee = _lastTotalPayedForSecondGrantee;

        await _grantFromManager.approvePayout(
          approveAmount,
          _secondGranteeWallet.address
        );

        let {
          totalPayed: finalTotalPayedForSecondGrantee
        } = await _grantFromManager.grantees(_secondGranteeWallet.address);

        expect(initialTotalPayedForSecondGrantee.add(approveAmount)).to.eq(
          finalTotalPayedForSecondGrantee
        );
        _lastTotalPayedForSecondGrantee = finalTotalPayedForSecondGrantee;
      });

      it("should be updated with another sum of approved amount", async () => {
        let approveAmount = 250;

        const initialTotalPayedForGrantee = _lastTotalPayedForGrantee;
        await _grantFromManager.approvePayout(
          approveAmount,
          _granteeWallet.address
        );

        let {
          totalPayed: finalTotalPayedForGrantee
        } = await _grantFromManager.grantees(_granteeWallet.address);

        expect(initialTotalPayedForGrantee.add(approveAmount)).to.be.eq(
          finalTotalPayedForGrantee
        );
        _lastTotalPayedForGrantee = finalTotalPayedForGrantee;

        approveAmount = 200;

        const initialTotalPayedForSecondGrantee = _lastTotalPayedForSecondGrantee;
        await _grantFromManager.approvePayout(
          approveAmount,
          _secondGranteeWallet.address
        );

        let {
          totalPayed: finalTotalPayedForSecondGrantee
        } = await _grantFromManager.grantees(_secondGranteeWallet.address);

        expect(initialTotalPayedForSecondGrantee.add(approveAmount)).to.eq(
          finalTotalPayedForSecondGrantee
        );
        _lastTotalPayedForSecondGrantee = finalTotalPayedForSecondGrantee;
      });

      it("should be updated with final sum of approved amount", async () => {
        let approveAmount = 250;

        const initialTotalPayedForGrantee = _lastTotalPayedForGrantee;
        await _grantFromManager.approvePayout(
          approveAmount,
          _granteeWallet.address
        );

        let {
          totalPayed: finalTotalPayedForGrantee
        } = await _grantFromManager.grantees(_granteeWallet.address);

        expect(initialTotalPayedForGrantee.add(approveAmount)).to.be.eq(
          finalTotalPayedForGrantee
        );
        _lastTotalPayedForGrantee = finalTotalPayedForGrantee;

        approveAmount = 50;

        const initialTotalPayedForSecondGrantee = _lastTotalPayedForSecondGrantee;
        await _grantFromManager.approvePayout(
          approveAmount,
          _secondGranteeWallet.address
        );

        let {
          totalPayed: finalTotalPayedForSecondGrantee
        } = await _grantFromManager.grantees(_secondGranteeWallet.address);

        expect(initialTotalPayedForSecondGrantee.add(approveAmount)).to.eq(
          finalTotalPayedForSecondGrantee
        );
        _lastTotalPayedForSecondGrantee = finalTotalPayedForSecondGrantee;
      });

      it("should not be updated with any approved amount", async () => {
        const approveAmount = 250;

        await expect(
          _grantFromManager.approvePayout(approveAmount, _granteeWallet.address)
        ).to.be.revertedWith(
          "approvePayout::Invalid Argument. value cannot exceed remaining allocation."
        );

        // const initialTotalPayedForSecondGrantee = _lastTotalPayedForSecondGrantee;
        await expect(
          _grantFromManager.approvePayout(
            approveAmount,
            _secondGranteeWallet.address
          )
        ).to.be.revertedWith(
          "approvePayout::Invalid Argument. value cannot exceed remaining allocation."
        );

        // let {
        //   totalPayed: finalTotalPayedForSecondGrantee
        // } = await _grantFromManager.grantees(_secondGranteeWallet.address);

        // expect(initialTotalPayedForSecondGrantee.add(approveAmount)).to.eq(
        //   finalTotalPayedForSecondGrantee
        // );
        // _lastTotalPayedForSecondGrantee = finalTotalPayedForSecondGrantee;
      });
    });
  });
});
