pragma solidity 0.6.5;

import "hardhat/console.sol";

contract Greeter {
    //
    // STORAGE:
    //

    string private greeting;
    address private admin;

    //
    // EVENTS:
    //

    /**
     * @dev Emit when changing admin.
     */
    event AdminChanged(address admin);

    /**
     * @dev Emit when changing greeting.
     */
    event GreetingChanged(string greeting);

    //
    // MODIFIERS:
    //

    /**
     * @dev Must be called by current admin,
     */
    modifier onlyAdmin() {
        require(msg.sender == admin, "Must be called by admin");
        _;
    }

    //
    // CONSTRUCTOR:
    //

    /**
     * @dev Construct greeter, set initial data.
     * @param _admin (address) - Initail admin.
     * @param _greeting (string) - Initial greeting.
     */
    constructor(address _admin, string memory _greeting) public {
        require(_admin != address(0), "Cannot be zero address");

        console.log("Deploying Greeter with greeting:", _greeting);

        greeting = _greeting;
        admin = _admin;
    }

    //
    // PUBLIC FUNCTIONS:
    //

    /**
     * @dev Set the admin. Must be called by existing admin.
     * @param _admin (address) - New admin address.
     */
    function setAdmin(address _admin) external onlyAdmin {
        admin = _admin;

        emit AdminChanged(_admin);
    }

    /**
     * @dev Get the current admin.
     * @return address - Admin address.
     */
    function getAdmin() external view returns (address) {
        return admin;
    }

    /**
     * @dev Set the greeting. Must be called by admin.
     * @param _greeting (string) - New greeting.
     */
    function setGreeting(string calldata _greeting) external onlyAdmin {
        greeting = _greeting;

        emit GreetingChanged(_greeting);
    }

    /**
     * @dev Get the greeting.
     * @return string - Greeting message.
     */
    function getGreeting() external view returns (string memory) {
        return greeting;
    }
}
